"""Gilbarco Passport NAXML-POSJournal parser (P1-9 — the market
wedge, HANDOFF.md §2).

Passport writes one PJR*.xml file per register event to its
back-office share. Each file is a ``NAXML-POSJournal`` document
holding exactly one event — a sale, refund, void, register
open/close ("other"), or financial event (safe drop). This module
turns those files into typed events and rolls a batch of them up
into per-(business day, register) aggregates that map 1:1 onto
the DayClose module's RegisterClose + DepartmentSale shapes.

Ground truth from a real Passport 22.01 site (23 business days,
~17.7k files — see task #97):

* ``BusinessDate`` is authoritative: the register's business day
  rolls at the site's day close (e.g. ~22:50), NOT midnight, and
  every event carries the day it belongs to.
* **An event's time is its EventStart / EventEnd date and time —
  nothing else** (the owner's rule). The event holds
  ``EventStartDate`` + ``EventStartTime`` (the cashier began the
  ticket) and ``EventEndDate`` + ``EventEndTime`` as separate date
  and time elements. ``ReceiptDate`` + ``ReceiptTime`` (the receipt
  print) is display detail, not the event's time. The JournalHeader's
  ``BeginDate`` + ``BeginTime`` is the start of the report PERIOD the
  file belongs to (the day close, e.g. 22:51:54, with ``EndDate``
  2100-01-01 while the period is open), the same on every file of a
  business day, so it says nothing about when the event happened.
  On a real export of 105,152 files every event has a start and an
  end, and none has an ISO ``EventDateTime``. The hourly chart
  reads the start, else the end (``_event_hour``).
* Refund events carry NEGATIVE amounts end-to-end (summary and
  tenders), so plain summation nets them out of a day.
* Void events contain only ``status="cancel"`` lines. Those lines
  are PARSED and kept (G-5 — an operator needs to see that an item
  was voided mid-sale), flagged ``status="cancel"``, and excluded
  from every money total. A void event therefore still nets to
  zero, but is no longer invisible.
* ``MerchandiseCode`` is the site's numeric department. Fuel
  lines (``FuelLine``) additionally carry the grade, gallons
  (3-decimal quantity), and pump position.
* A TransactionLine holds one of four sale lines: ``ItemLine``
  (a scanned or PLU item), ``FuelLine``, ``MerchandiseCodeLine``
  (an amount keyed straight to a department, no scan code — open
  department sales, lotto sales, and lottery / lotto cashes as
  negative amounts) and ``FuelPrepayLine``. The first three are
  sales and are parsed into ``items``. A prepay is only a deposit
  on a pump and carries no MerchandiseCode, so it is not an item;
  the event just records that it holds one (``has_fuel_prepay``).
* **Tax is inside TransactionTotalNetAmount.** On real Passport
  files NetAmount always equals GrandAmount (what the customer
  paid), so the pre-tax sale is NetAmount − TransactionTotalTax-
  NetAmount (``PjrEvent.sales_cents``). That figure is also
  exactly the sum of the normal lines' SalesAmount, which Passport
  writes after promotions; TransactionTotalGrossAmount is before
  promotions (a $50.73 pump sale with a $2.06 promotion has gross
  50.73 and a 48.67 FuelLine). Checked on 103,954 real sales and
  refunds: Net = Grand and Net − Tax = Σ lines on every one, and
  tenders − (sales + tax) is −$60 over the whole export, where
  using Gross instead is −$10,936 (the promotions).
* **A prepaid fuel ticket is written twice.** Passport writes the
  deposit (a normal FuelPrepayLine, the other items, the tenders)
  when the customer pays. When the pump stops it writes a
  completion carrying ``LinkedTransactionInfo`` with
  ``TransactionLinkReason`` fuelPrepay that restates the WHOLE
  ticket: same items, same tenders, the prepay line cancelled and
  a FuelLine for what was pumped. ``OriginalRegisterID`` +
  ``OriginalTransactionID`` + ``OriginalEventStartDate`` +
  ``OriginalEventStartTime`` name the deposit. When a sale or
  refund completion exists, the deposit leaves every money total
  (``supersede_prepaid_deposits``); it stays in the transaction
  viewer, marked superseded. A completion written as a VoidEvent
  supersedes nothing: voids never count, so dropping the deposit
  would drop the sale. Passport can chain completions (the pump
  stops, then the change is handed back): the later one names the
  earlier one, which is superseded the same way. On a real export
  of 105,152 files: 4,661 links, no event restated twice, three
  pairs on different business dates.
* **Two tickets restate a deposit with no usable link** (found in
  the same export, two stores; owner, 2026-11-20: book the real
  figure). Both replace their deposit only when they restate it
  (the deposit's tenders and items are on them) within an hour on
  the same register (``_supersede_unlinked``):

  - **A cancelled or moved prepay.** The cashier cancels the
    prepay (or moves it to another pump) and Passport writes a
    new, UNLINKED sale (a refund when the ticket nets negative):
    the deposit's whole ticket again, its prepay line cancelled,
    the prepaid money handed back as change. It names no deposit,
    so it is paired with the suspended deposit on the same register
    and business day that holds the cancelled pump and amount. 45
    such deposits were counted on top of the real sale ($1,701.71).
  - **The middle ticket of a three-ticket chain** names the
    deposit by its OWN start time, so its key matches nothing; it
    is paired by register and transaction number instead (2
    deposits, $149.67).

  A deposit completed only by a void, or followed by nothing,
  still counts, as before.
* Change back to the customer appears as a negative cash tender
  with ``ChangeFlag="yes"`` — summing tenders as-is yields net
  cash taken in.

The XML arrives from customer sites — untrusted input — so it is
parsed exclusively through defusedxml. Money is integer cents
(P0-3); gallons stay floats (volume, not money — same rationale
as ``StoreEmployee.hourly_rate``).

Parse errors raise ``PosJournalParseError`` with a user-safe
message; the caller decides whether a bad file poisons a batch or
is just reported and skipped.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from defusedxml import ElementTree as SafeET

from api.Core.Money import to_cents


class PosJournalParseError(Exception):
    """Malformed / non-POSJournal input (message is user-safe)."""


# NAXML event tag → our event kind.
_EVENT_KINDS = {
    "SaleEvent": "sale",
    "RefundEvent": "refund",
    "VoidEvent": "void",
    "OtherEvent": "other",
    "FinancialEvent": "financial",
}

# Tender codes that mean "a card network settles this" — includes
# the outside (pay-at-pump) variants.
CARD_TENDER_CODES = frozenset({
    "creditCards", "debitCards", "outsideCredit", "outsideDebit",
    "outsideMobileCredit", "outsideMobileDebit",
})
CASH_TENDER_CODES = frozenset({"cash"})


# TransactionLine status="cancel" — a line the register itself
# discarded (a voided item, a mis-scan corrected mid-sale).
LINE_STATUS_NORMAL = "normal"
LINE_STATUS_CANCEL = "cancel"

# LinkedTransactionInfo/TransactionLinkReason of a prepay completion.
LINK_REASON_FUEL_PREPAY = "fuelPrepay"

# The event kinds that carry money. Voids, register opens and
# financial events never reach a sales total.
SALES_KINDS = ("sale", "refund")


@dataclass
class PjrItemLine:
    merchandise_code: str
    description: str
    quantity: float
    amount_cents: int
    is_fuel: bool = False
    fuel_grade_id: str = ""
    fuel_position: str = ""
    gallons: float = 0.0
    # Item identity for the price-book warm start (P2-3): the scan
    # code (UPC digits or keyed PLU), its format, and the shelf
    # price at the time of sale. Fuel lines carry none of these.
    pos_code: str = ""
    pos_code_format: str = ""
    regular_price_cents: int = 0
    # G-5 additions — for the transaction viewer, not the money math.
    #
    # `status` is the load-bearing one. Cancelled lines used to be
    # dropped during parse; they are now kept so an operator can see
    # that an item WAS voided mid-sale (a real loss-prevention
    # signal). Everything that computes money MUST filter on
    # `status == LINE_STATUS_NORMAL` — `aggregate_events` does, and
    # a cancelled line reaching a day total would silently inflate
    # it.
    status: str = LINE_STATUS_NORMAL
    line_seq: int = 0
    entry_method: str = ""
    actual_price_cents: int = 0
    selling_units: str = ""
    tax_level_id: str = ""


@dataclass
class PjrTender:
    code: str
    sub_code: str
    amount_cents: int
    is_change: bool
    # Same rule as PjrItemLine.status — a tender on a cancelled
    # line never counts toward a drawer total.
    status: str = LINE_STATUS_NORMAL


@dataclass
class PjrPrepayLine:
    """One FuelPrepayLine: the pump and the amount prepaid on it.
    Never money on its own (no MerchandiseCode; the completion's
    FuelLine is the sale). Kept so a later ticket that cancels it can
    be paired with its deposit (``supersede_prepaid_deposits``)."""

    fuel_position: str
    amount_cents: int
    status: str = LINE_STATUS_NORMAL


# Aggregation key + display label for pay-at-pump activity. All
# outside (OutsideSalesFlag="yes") events collapse into one
# virtual register per day: pump registers carry synthetic IDs
# (10008, …) that operators never reconcile individually.
OUTSIDE_REGISTER_KEY = "outside"
OUTSIDE_REGISTER_LABEL = "Pay at pump"


@dataclass
class PjrEvent:
    kind: str
    business_date: date | None
    register_id: str
    cashier_id: str
    till_id: str
    transaction_id: str
    outside: bool = False
    # Clock hour 0-23 the event started (G-3, hourly sales), read
    # from the event's own clock (see _event_hour), never the
    # report period's; None when the event carries none — hourly
    # charts simply skip such events, day totals are unaffected.
    event_hour: int | None = None
    items: list[PjrItemLine] = field(default_factory=list)
    tenders: list[PjrTender] = field(default_factory=list)
    gross_cents: int = 0
    net_cents: int = 0
    tax_cents: int = 0
    # OtherEvent register-open detail: the opening drawer float.
    opening_cash_cents: int | None = None
    # G-5 — event detail for the transaction viewer. None/"" when
    # the file omits them; nothing here feeds a money total.
    event_sequence_id: str = ""
    started_at: datetime | None = None
    ended_at: datetime | None = None
    receipt_at: datetime | None = None
    training_mode: bool = False
    offline: bool = False
    suspended: bool = False
    grand_total_cents: int = 0
    # Filename the event was parsed from. Set by the caller that
    # loaded it (parse_pjr sees bytes, not a name); it is what makes
    # the persisted transaction idempotent across re-commits — one
    # event per file, so re-parsing replaces rather than duplicates.
    source_file: str = ""
    # Fuel prepay (see the module docstring). A deposit holds a
    # normal-status FuelPrepayLine; a completion carries the link to
    # the deposit it restates.
    has_fuel_prepay: bool = False
    # Every FuelPrepayLine on the ticket, cancelled ones included.
    prepay_lines: list[PjrPrepayLine] = field(default_factory=list)
    link_reason: str = ""
    linked_register_id: str = ""
    linked_transaction_id: str = ""
    linked_started_at: datetime | None = None
    # Set by ``supersede_prepaid_deposits``, never by the parse: a
    # deposit whose completion exists. It stays visible but no
    # longer counts toward any money total.
    superseded: bool = False
    superseded_by_file: str = ""
    # Set by ``supersede_prepaid_deposits`` on a ticket that replaced
    # a deposit without naming it (``_supersede_unlinked``), so it
    # replaces exactly one however often the matching runs (a day's
    # commit runs it three times).
    replaced_unlinked: bool = False

    @property
    def sales_cents(self) -> int:
        """The pre-tax sale after promotions — what DayClose books as
        gross_sales. NetAmount already includes tax (module
        docstring), so tax comes off it."""
        return self.net_cents - self.tax_cents

    @property
    def counts_toward_sales(self) -> bool:
        """True for the events every money total sums: sales and
        refunds, minus deposits a prepay completion superseded."""
        return self.kind in SALES_KINDS and not self.superseded

    @property
    def identity_key(self) -> str:
        """This event under the four keys a completion names its
        original by (``prepay_link_key``)."""
        return prepay_link_key(
            self.register_id, self.transaction_id, self.started_at,
        )

    @property
    def prepay_key(self) -> str:
        """For a deposit, its own identity; for a fuelPrepay
        completion, the identity of the event it restates. The two
        halves of one prepaid ticket share this key; "" otherwise."""
        if self.link_reason == LINK_REASON_FUEL_PREPAY:
            return prepay_link_key(
                self.linked_register_id, self.linked_transaction_id,
                self.linked_started_at,
            )
        if self.has_fuel_prepay:
            return prepay_link_key(
                self.register_id, self.transaction_id, self.started_at,
            )
        return ""

    @property
    def completes_prepay(self) -> bool:
        """A completion that supersedes its deposit. Only a sale or
        refund does: a void completion counts for nothing, so letting
        it drop the deposit would drop the sale."""
        return (
            self.link_reason == LINK_REASON_FUEL_PREPAY
            and self.kind in SALES_KINDS
            and bool(self.prepay_key)
        )

    @property
    def is_prepay_deposit(self) -> bool:
        return (
            self.has_fuel_prepay
            and self.link_reason != LINK_REASON_FUEL_PREPAY
            and self.kind in SALES_KINDS
            and bool(self.prepay_key)
        )

    @property
    def can_be_superseded(self) -> bool:
        """A sale or refund that is part of a prepaid ticket: the
        deposit, or a completion a later completion restates in turn
        (Passport chains them when change is handed back after the
        pump stopped). Only these are ever matched to a completion."""
        return (
            self.kind in SALES_KINDS
            and (
                self.has_fuel_prepay
                or self.link_reason == LINK_REASON_FUEL_PREPAY
            )
            and bool(self.identity_key)
        )

    @property
    def cancels_prepay(self) -> bool:
        """A sale or refund with no link that cancels a prepay line:
        what Passport writes when the cashier cancels a prepay or
        moves it to another pump. It restates the deposit's ticket
        and hands the prepaid money back, but names no deposit
        (module docstring). A refund when the ticket nets negative
        (a lottery cash on it)."""
        return (
            self.kind in SALES_KINDS
            and not self.link_reason
            and any(
                p.status == LINE_STATUS_CANCEL for p in self.prepay_lines
            )
        )


def prepay_link_key(
    register_id: str, transaction_id: str, started_at: datetime | None,
) -> str:
    """Register + transaction number + start time: the four keys
    Passport links a completion to its deposit by (date and time are
    one datetime here). "" when any part is missing — an event the
    key cannot name is never matched to anything."""
    if not register_id or not transaction_id or started_at is None:
        return ""
    return f"{register_id}|{transaction_id}|{started_at:%Y-%m-%dT%H:%M:%S}"


def _text(el, tag: str) -> str:
    found = el.find(".//" + tag)
    if found is None or found.text is None:
        return ""
    return found.text.strip()


def _cents(el, tag: str) -> int:
    raw = _text(el, tag)
    if not raw:
        return 0
    try:
        return to_cents(raw)
    except ValueError:
        raise PosJournalParseError(
            f"Bad money value {raw!r} in <{tag}>",
        )


def _float(el, tag: str) -> float:
    raw = _text(el, tag)
    if not raw:
        return 0.0
    try:
        return float(raw)
    except ValueError:
        raise PosJournalParseError(
            f"Bad numeric value {raw!r} in <{tag}>",
        )


def _flag(el, tag: str) -> bool:
    """NAXML boolean flags are an attribute, not text:
    ``<TrainingModeFlag value="no"/>``."""
    found = el.find(".//" + tag)
    return found is not None and (found.get("value") or "") == "yes"


def _date(el, tag: str) -> date | None:
    raw = _text(el, tag)
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        raise PosJournalParseError(
            f"Bad date {raw!r} in <{tag}>",
        )


def _stamp(el, date_tag: str, time_tag: str) -> datetime | None:
    """Combine a sibling <XxxDate> + <XxxTime> pair into a datetime.

    Returns None when either half is missing or unparseable —
    timestamps are display detail, so a malformed one must never
    fail a parse that would otherwise book money correctly.
    """
    d = _text(el, date_tag)
    t = _text(el, time_tag) or "00:00:00"
    if not d:
        return None
    try:
        return datetime.strptime(f"{d} {t[:8]}", "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


# The event's own clock times, best first (see _event_hour). Only
# the EventStart / EventEnd pair: an event's time is never its
# ReceiptTime or the JournalHeader's BeginTime (module docstring).
_EVENT_CLOCK_TAGS = ("EventStartTime", "EventEndTime")


def _event_hour(event_el) -> int | None:
    """Clock hour 0-23 for the hourly chart (G-3): when the event
    started, from the same ``EventStartTime`` that ``started_at``
    and the prepay link read; else when it ended
    (``EventEndTime``). On real files the two agree on 99.6% of
    sales; the rest are tickets that ran past the top of an hour,
    and they belong to the hour the cashier began them.

    Never ``ReceiptTime``: the owner's rule is that an event's time
    is its EventStart / EventEnd date and time only. (Every real
    sale and refund has a start; the end is a safety net.)

    Never the JournalHeader's ``BeginTime``. That is the report
    period's start (module docstring), so it files a whole business
    day under the hour of the day close (on a real export, 98.6% of
    sales landed in 22:00 or 23:00). An event with no clock of its
    own yields None, which only mutes the chart; a period time would
    fill it with a plausible, wrong shape.

    Only the time element is read: a missing or malformed one falls
    through to the next candidate. (``_stamp`` reads a missing time
    as midnight, which would put such an event in hour 0.)
    """
    for tag in _EVENT_CLOCK_TAGS:
        raw = _text(event_el, tag)
        try:
            return datetime.strptime(raw[:8], "%H:%M:%S").hour
        except ValueError:
            continue
    return None


def _parse_item_line(line_el, *, status: str = LINE_STATUS_NORMAL,
                     line_seq: int = 0) -> list[PjrItemLine]:
    """Every ItemLine / FuelLine / MerchandiseCodeLine under one
    TransactionLine (FuelPrepayLine is skipped on purpose — see the
    module docstring).

    `status` is the parent TransactionLine's — a cancelled line's
    items are kept (so the viewer can show what was voided) and
    carry the flag that keeps them out of every money total.
    """
    items: list[PjrItemLine] = []
    for item in line_el.findall(".//ItemLine"):
        fmt_el = item.find(".//ItemCode/POSCodeFormat")
        entry_el = item.find(".//EntryMethod")
        items.append(PjrItemLine(
            merchandise_code=_text(item, "MerchandiseCode"),
            description=_text(item, "Description"),
            quantity=_float(item, "SalesQuantity"),
            amount_cents=_cents(item, "SalesAmount"),
            pos_code=_text(item, "ItemCode/POSCode"),
            pos_code_format=(
                (fmt_el.get("format") or "") if fmt_el is not None else ""
            ),
            regular_price_cents=_cents(item, "RegularSellPrice"),
            status=status,
            line_seq=line_seq,
            entry_method=(
                (entry_el.get("method") or "") if entry_el is not None else ""
            ),
            actual_price_cents=_cents(item, "ActualSalesPrice"),
            selling_units=_text(item, "SellingUnits"),
            tax_level_id=_text(item, "ItemTax/TaxLevelID"),
        ))
    for fuel in line_el.findall(".//FuelLine"):
        items.append(PjrItemLine(
            merchandise_code=_text(fuel, "MerchandiseCode"),
            description=_text(fuel, "Description"),
            quantity=_float(fuel, "SalesQuantity"),
            amount_cents=_cents(fuel, "SalesAmount"),
            is_fuel=True,
            fuel_grade_id=_text(fuel, "FuelGradeID"),
            fuel_position=_text(fuel, "FuelPositionID"),
            gallons=_float(fuel, "SalesQuantity"),
            status=status,
            line_seq=line_seq,
            actual_price_cents=_cents(fuel, "ActualSalesPrice"),
        ))
    for dept in line_el.findall(".//MerchandiseCodeLine"):
        # Keyed to a department, never scanned: no ItemCode, so
        # pos_code stays "" and the item-movement and price-book
        # passes (which need a scan code) skip it, while the
        # department rollup and the transaction viewer count it.
        items.append(PjrItemLine(
            merchandise_code=_text(dept, "MerchandiseCode"),
            description=_text(dept, "Description"),
            quantity=_float(dept, "SalesQuantity"),
            amount_cents=_cents(dept, "SalesAmount"),
            regular_price_cents=_cents(dept, "RegularSellPrice"),
            status=status,
            line_seq=line_seq,
            actual_price_cents=_cents(dept, "ActualSalesPrice"),
            tax_level_id=_text(dept, "ItemTax/TaxLevelID"),
        ))
    return items


def parse_pjr(data: bytes | str) -> PjrEvent:
    """Parse one PJR*.xml POSJournal file into a typed event."""
    if isinstance(data, str):
        data = data.encode("ISO-8859-1", errors="replace")
    try:
        root = SafeET.fromstring(data)
    except Exception:
        raise PosJournalParseError("Not well-formed XML.")
    if "POSJournal" not in (root.tag or ""):
        raise PosJournalParseError(
            "Not a NAXML POSJournal document "
            f"(root <{root.tag}>).",
        )

    event_el = None
    kind = ""
    for tag, k in _EVENT_KINDS.items():
        event_el = root.find(".//" + tag)
        if event_el is not None:
            kind = k
            break
    if event_el is None:
        raise PosJournalParseError(
            "POSJournal contains no recognized event.",
        )

    outside_el = event_el.find(".//OutsideSalesFlag")
    event = PjrEvent(
        kind=kind,
        business_date=_date(event_el, "BusinessDate"),
        register_id=_text(event_el, "RegisterID"),
        cashier_id=_text(event_el, "CashierID"),
        till_id=_text(event_el, "TillID"),
        transaction_id=_text(event_el, "TransactionID"),
        outside=(
            outside_el is not None and outside_el.get("value") == "yes"
        ),
        event_hour=_event_hour(event_el),
        event_sequence_id=_text(event_el, "EventSequenceID"),
        started_at=_stamp(event_el, "EventStartDate", "EventStartTime"),
        ended_at=_stamp(event_el, "EventEndDate", "EventEndTime"),
        receipt_at=_stamp(event_el, "ReceiptDate", "ReceiptTime"),
        training_mode=_flag(event_el, "TrainingModeFlag"),
        offline=_flag(event_el, "OfflineFlag"),
        suspended=_flag(event_el, "SuspendFlag"),
    )

    link = event_el.find(".//LinkedTransactionInfo")
    if link is not None:
        event.link_reason = _text(link, "TransactionLinkReason")
        event.linked_register_id = _text(link, "OriginalRegisterID")
        event.linked_transaction_id = _text(link, "OriginalTransactionID")
        event.linked_started_at = _stamp(
            link, "OriginalEventStartDate", "OriginalEventStartTime",
        )

    # Register open/close detail (OtherEvent): opening drawer cash.
    detail = event_el.find(".//RegisterDetail")
    if detail is not None and detail.get("detailType") == "open":
        event.opening_cash_cents = _cents(detail, "CashInDrawer")

    for seq, line in enumerate(event_el.findall(".//TransactionLine"), 1):
        # Cancelled lines are corrections the register already
        # discarded — voided items, mis-scans. They are KEPT here
        # (G-5: an operator wants to see that something was voided
        # mid-sale) and flagged, so everything downstream that
        # computes money can filter them out. `aggregate_events`
        # does exactly that; day totals are unchanged.
        status = (
            LINE_STATUS_CANCEL if line.get("status") == "cancel"
            else LINE_STATUS_NORMAL
        )
        event.items.extend(
            _parse_item_line(line, status=status, line_seq=seq),
        )
        for prepay in line.findall(".//FuelPrepayLine"):
            event.prepay_lines.append(PjrPrepayLine(
                fuel_position=_text(prepay, "FuelPositionID"),
                amount_cents=_cents(prepay, "SalesAmount"),
                status=status,
            ))
            if status == LINE_STATUS_NORMAL:
                event.has_fuel_prepay = True
        for tender in line.findall(".//TenderInfo"):
            change_el = tender.find(".//ChangeFlag")
            event.tenders.append(PjrTender(
                code=_text(tender, "TenderCode"),
                sub_code=_text(tender, "TenderSubCode"),
                amount_cents=_cents(tender, "TenderAmount"),
                is_change=(
                    change_el is not None
                    and change_el.get("value") == "yes"
                ),
                status=status,
            ))

    summary = event_el.find(".//TransactionSummary")
    if summary is not None:
        event.gross_cents = _cents(summary, "TransactionTotalGrossAmount")
        event.net_cents = _cents(summary, "TransactionTotalNetAmount")
        event.tax_cents = _cents(summary, "TransactionTotalTaxNetAmount")
        event.grand_total_cents = _cents(
            summary, "TransactionTotalGrandAmount",
        )
    return event


# ── Fuel prepay pairs ──────────────────────────────────────


def supersede_prepaid_deposits(
    events: list[PjrEvent], completions: Iterable[PjrEvent] = (),
) -> int:
    """Mark every prepay deposit in ``events`` whose completion is in
    ``events`` or ``completions`` (the module docstring has the
    rule). ``completions`` is for completions that live outside the
    list being booked — staged on a later business day. Then pair
    the two kinds of ticket that restate a deposit without a usable
    link (``_supersede_unlinked``). Marking only ever adds, so
    calling this twice is harmless. Returns how many deposits it
    newly marked."""
    pool = [*events, *completions]
    by_key: dict[str, PjrEvent] = {}
    for ev in pool:
        if ev.completes_prepay:
            by_key.setdefault(ev.prepay_key, ev)
    marked = 0
    for ev in events:
        if ev.superseded or not ev.can_be_superseded:
            continue
        completion = by_key.get(ev.identity_key)
        if completion is None or completion is ev:
            continue
        ev.superseded = True
        ev.superseded_by_file = completion.source_file
        marked += 1
    return marked + _supersede_unlinked(events, pool)


# How long after a deposit Passport writes a ticket that restates it
# without a usable link. On both real exports the longest gap was 44
# minutes (a $100 prepay cancelled after the customer waited); an
# hour leaves room and still keeps a reused transaction number
# (Passport wraps them) far out of reach.
UNLINKED_RESTATE_WINDOW = timedelta(hours=1)


def _restates(later: PjrEvent, earlier: PjrEvent) -> bool:
    """True when ``later`` repeats ``earlier``'s ticket: every tender
    the customer handed over on ``earlier`` and every item rung on it
    are on ``later`` too. A completion and a cancelling ticket always
    do (they restate the whole ticket); an unrelated sale practically
    never carries the same money and the same items."""
    def handed_over(e: PjrEvent) -> Counter[tuple[str, int]]:
        return Counter(
            (t.code, t.amount_cents) for t in e.tenders
            if t.status == LINE_STATUS_NORMAL and not t.is_change
        )

    def rung(e: PjrEvent) -> Counter[tuple[str, str, int]]:
        return Counter(
            (i.pos_code, i.merchandise_code, i.amount_cents)
            for i in e.items if i.status == LINE_STATUS_NORMAL
        )

    return (
        not (handed_over(earlier) - handed_over(later))
        and not (rung(earlier) - rung(later))
    )


def _latest_before(
    later: PjrEvent, candidates: Iterable[PjrEvent],
) -> PjrEvent | None:
    """The candidate that started last within the window before
    ``later`` started, or None."""
    if later.started_at is None:
        return None
    best: tuple[datetime, PjrEvent] | None = None
    for e in candidates:
        if e.started_at is None or e is later:
            continue
        if not (e.started_at < later.started_at
                <= e.started_at + UNLINKED_RESTATE_WINDOW):
            continue
        if best is None or e.started_at > best[0]:
            best = (e.started_at, e)
    return best[1] if best is not None else None


def _supersede_unlinked(
    events: list[PjrEvent], pool: list[PjrEvent],
) -> int:
    """The two tickets that restate a deposit with no usable link
    (module docstring, "no usable link"). Each pairs with the latest
    open deposit before it on the same register, within
    ``UNLINKED_RESTATE_WINDOW``, that it restates (``_restates``).
    Anything that does not fit stays as it is: the deposit keeps
    counting, as before."""
    by_register: dict[str, list[PjrEvent]] = defaultdict(list)
    for e in events:
        by_register[e.register_id].append(e)
    identities = {e.identity_key for e in pool if e.identity_key}
    marked = 0

    # 1. A completion that names its deposit by its OWN start time
    #    (the suspended middle ticket of a three-ticket chain): the
    #    key it carries matches nothing, so pair it by register and
    #    transaction number instead.
    for c in pool:
        if not (
            c.completes_prepay
            and not c.replaced_unlinked
            and c.linked_started_at is not None
            and c.linked_started_at == c.started_at
            and c.prepay_key not in identities
        ):
            continue
        target = _latest_before(c, (
            e for e in by_register.get(c.linked_register_id, [])
            if not e.superseded and e.can_be_superseded
            and e.transaction_id == c.linked_transaction_id
            and _restates(c, e)
        ))
        if target is not None:
            target.superseded = True
            target.superseded_by_file = c.source_file
            c.replaced_unlinked = True
            marked += 1

    # 2. A sale that cancels a prepay line and names nothing (the
    #    prepay was cancelled or moved): it replaces the suspended
    #    deposit holding that same pump and amount.
    restating = sorted(
        (
            e for e in events
            if e.cancels_prepay and not e.replaced_unlinked
            and e.started_at is not None
        ),
        key=lambda e: e.started_at or datetime.min,
    )
    for r in restating:
        cancelled = {
            (p.fuel_position, p.amount_cents) for p in r.prepay_lines
            if p.status == LINE_STATUS_CANCEL
        }
        target = _latest_before(r, (
            e for e in by_register.get(r.register_id, [])
            if not e.superseded and e.is_prepay_deposit and e.suspended
            and e.business_date == r.business_date
            and any(
                (p.fuel_position, p.amount_cents) in cancelled
                for p in e.prepay_lines if p.status == LINE_STATUS_NORMAL
            )
            and _restates(r, e)
        ))
        if target is not None:
            target.superseded = True
            target.superseded_by_file = r.source_file
            r.replaced_unlinked = True
            marked += 1
    return marked


# ── Day aggregation ────────────────────────────────────────


@dataclass
class FuelGradeAggregate:
    grade_id: str
    description: str
    gallons: float = 0.0
    amount_cents: int = 0


@dataclass
class RegisterDayAggregate:
    """One register's business day, rolled up from its journal
    events. Maps onto DayClose's RegisterClose + DepartmentSale:
    ``net_sales_cents`` → gross_sales (Σ ``PjrEvent.sales_cents``:
    merchandise + fuel after promotions, refunds netted, tax NOT
    included — TransactionTotalNetAmount carries tax, so it comes
    off), ``tax_cents`` → sales_tax, tender buckets →
    cash/card/other totals, ``departments`` → department sale
    lines (keyed by the site's numeric MerchandiseCode — the
    operator maps codes to their Department catalog at review
    time). A prepay deposit its completion superseded counts in
    none of these; the completion carries the ticket."""

    business_date: date
    register_id: str
    net_sales_cents: int = 0
    refunds_cents: int = 0
    tax_cents: int = 0
    cash_cents: int = 0
    card_cents: int = 0
    other_tender_cents: int = 0
    opening_cash_cents: int | None = None
    sale_count: int = 0
    refund_count: int = 0
    departments: dict[str, int] = field(default_factory=dict)
    fuel: dict[str, FuelGradeAggregate] = field(default_factory=dict)


def aggregate_events(
    events: list[PjrEvent],
) -> list[RegisterDayAggregate]:
    """Roll parsed events into per-(business day, register)
    aggregates, sorted by day then register. Events without a
    business date are ignored (they cannot be booked to a day);
    void events contribute nothing; a prepay deposit whose
    completion is in ``events`` (or was marked earlier, e.g. from a
    later staged day) is left out entirely."""
    supersede_prepaid_deposits(events)
    by_key: dict[tuple[date, str], RegisterDayAggregate] = {}
    for ev in events:
        if ev.business_date is None or ev.superseded:
            continue
        register_key = (
            OUTSIDE_REGISTER_KEY if ev.outside else (ev.register_id or "")
        )
        key = (ev.business_date, register_key)
        agg = by_key.get(key)
        if agg is None:
            agg = RegisterDayAggregate(
                business_date=ev.business_date,
                register_id=register_key,
            )
            by_key[key] = agg

        if ev.kind == "other" and ev.opening_cash_cents is not None:
            # Register open — capture the first drawer float seen.
            if agg.opening_cash_cents is None:
                agg.opening_cash_cents = ev.opening_cash_cents
            continue
        if not ev.counts_toward_sales:
            continue

        if ev.kind == "sale":
            agg.sale_count += 1
        else:
            agg.refund_count += 1
            # Refund amounts are negative; track magnitude too.
            agg.refunds_cents += -ev.sales_cents

        agg.net_sales_cents += ev.sales_cents
        agg.tax_cents += ev.tax_cents
        for item in ev.items:
            # Voided lines are visible in the transaction viewer but
            # never money. Parsing keeps them; totals must not.
            if item.status != LINE_STATUS_NORMAL:
                continue
            code = item.merchandise_code or "?"
            agg.departments[code] = (
                agg.departments.get(code, 0) + item.amount_cents
            )
            if item.is_fuel:
                grade = agg.fuel.get(item.fuel_grade_id)
                if grade is None:
                    grade = FuelGradeAggregate(
                        grade_id=item.fuel_grade_id,
                        description=item.description,
                    )
                    agg.fuel[item.fuel_grade_id] = grade
                grade.gallons += item.gallons
                grade.amount_cents += item.amount_cents
        for tender in ev.tenders:
            if tender.status != LINE_STATUS_NORMAL:
                continue
            # Change lines are already negative — summing yields
            # net money taken in per tender bucket.
            if tender.code in CASH_TENDER_CODES:
                agg.cash_cents += tender.amount_cents
            elif tender.code in CARD_TENDER_CODES:
                agg.card_cents += tender.amount_cents
            else:
                agg.other_tender_cents += tender.amount_cents

    return sorted(
        by_key.values(),
        key=lambda a: (a.business_date, a.register_id),
    )


__all__ = [
    "CARD_TENDER_CODES", "CASH_TENDER_CODES",
    "LINE_STATUS_CANCEL", "LINE_STATUS_NORMAL", "FuelGradeAggregate",
    "LINK_REASON_FUEL_PREPAY", "OUTSIDE_REGISTER_KEY",
    "OUTSIDE_REGISTER_LABEL", "SALES_KINDS",
    "PjrEvent", "PjrItemLine", "PjrPrepayLine", "PjrTender",
    "PosJournalParseError", "RegisterDayAggregate",
    "UNLINKED_RESTATE_WINDOW", "aggregate_events", "parse_pjr",
    "prepay_link_key", "supersede_prepaid_deposits",
]

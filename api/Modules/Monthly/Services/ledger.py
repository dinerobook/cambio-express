"""Every dollar of one month, one row each — the Monthly P&L's
Transactions tab (INVARIANTS.md "Transactions").

The P&L statement is built from sums (`summarize_monthly`); this
module lists what those sums are made of, so a person can see — and
fix — where each dollar went. The rule it lives by is **one dollar,
one row**:

* a bank row that is already on the daily book (booked by the bank
  feed, or matched to a cashier's entry) is ONE row: the bank row,
  on the daily book's day, counted on the daily book's line. The
  daily book entry it stands for is not listed again;
* a bank row tagged with a P&L category (`pl_*`, a bank charge)
  counts on that line, in the month of its booking day;
* every other daily book figure is a row of its own: an entry
  (MSB cash / check purchases, expenses, payroll), else the day's
  figure for the line (sales, fees, the Store daily book);
* the return-check workflow and any value typed on the P&L are one
  row each;
* a bank row that needs a person is "to review"; one that is not
  P&L money (a deposit, a transfer between accounts) is "not in
  P&L". Neither counts.

`counted` rows add up to the statement, line by line:
Σ counted `amount` for a line == `summary.value(line)`
(tests/Modules/Monthly/test_transactions_ledger.py holds that for
every source). Pure read.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from api.Modules.Monthly.Services.daily_feed import (
    DAILY_DERIVED_FIELDS,
    DAILY_EXTRA_INCOME,
    DAILY_FED_FIELDS,
    month_bounds,
)
from api.Modules.Monthly.Services.monthly import (
    EXPENSE_FIELDS,
    INCOME_FIELDS,
    MonthlySummary,
)

FEATURE_FLAG = "pl_transactions"

# The views the tab offers, in the order it shows them.
VIEWS = ("review", "in_pl", "not_pl", "all")

# Row statuses. Bank: rule / person (tagged to a P&L line), added /
# matched (on the daily book), to_review, not_in_pl. Others: daily,
# returned_checks, typed. A daily figure on a line something else
# speaks for: bank_wins / typed_wins (listed, not counted).
COUNTED_ELSEWHERE = ("bank_wins", "typed_wins")


def pl_transactions_enabled(db: Session, store_id: int) -> bool:
    """The store's switch for the Transactions tab and the booking-day
    month rule. Opt-in (off until a superadmin turns it on), and only
    with bank matching on: without matching a bank deposit and the
    cashier's entry for it are two rows, and the list would show the
    same dollar twice."""
    from api.Modules.BankSync.Services import reconcile
    from api.Modules.Billing.Services.feature_flags import opt_in_flag_enabled

    return (
        opt_in_flag_enabled(db, store_id, FEATURE_FLAG)
        and reconcile.matching_enabled(db, store_id)
    )


@dataclass
class LedgerRow:
    key: str
    source: str          # bank | entry | day | service | money_order_charges | returned_checks | typed
    day: date | None
    description: str
    amount: float        # what the row adds to its line (signed)
    line: str | None
    status: str
    counted: bool
    bank_amount: float | None = None
    txn_id: int | None = None
    category_slug: str = ""
    rule_id: int | None = None
    item_kind: str = ""  # daily kind, Services box service, or book attr
    book: str = ""       # msb | store | ""
    account_label: str = ""
    report_date_override: date | None = None
    bank_date: date | None = None   # the bank's own posting date
    booked_on: date | None = None   # the day the bank feed booked it
    suggested_slug: str = ""        # Services/suggestions.py, rows to review
    suggested_source: str = ""      # history | template | ""
    section: str = ""               # a store category's half: income | expense
    # A daily entry that can go on another expense line
    # (`entry_categories.py`): its id, and the line it was put on
    # ("" = its kind's own line).
    entry_id: int | None = None
    entry_category: str = ""

    @property
    def bucket(self) -> str | None:
        if self.section:
            return self.section
        if self.line in INCOME_FIELDS:
            return "income"
        if self.line in EXPENSE_FIELDS:
            return "expense"
        return None

    @property
    def view(self) -> str:
        if self.status == "to_review":
            return "review"
        return "in_pl" if self.counted else "not_pl"


def _kind_lines() -> dict[str, str]:
    """daily line-item kind → the P&L line its entries roll into."""
    from api.Modules.DailyBook.Services import LINE_ITEM_KINDS

    msb_attr_to_line = {
        attr: col for col, sources in DAILY_DERIVED_FIELDS.items()
        for book, attr in sources if book == "msb"
    }
    return {
        kind: msb_attr_to_line[spec[0]]
        for kind, spec in LINE_ITEM_KINDS.items()
        if spec[0] in msb_attr_to_line
    }


def _book_lines(book: str) -> dict[str, str]:
    """book attr (or service) → P&L line, for one source family."""
    out: dict[str, str] = {}
    for family in (DAILY_DERIVED_FIELDS, DAILY_FED_FIELDS, DAILY_EXTRA_INCOME):
        for col, sources in family.items():
            for b, attr in sources:
                if b == book:
                    out[attr] = col
    return out


def _daily_status(summary: MonthlySummary, line: str) -> tuple[str, bool]:
    """Whether a daily book figure on `line` counts, by the P&L's own
    precedence (bank feed → daily books → typed)."""
    if line in summary.bank_fed:
        return "bank_wins", False
    d = summary.daily
    if line in d.derived or line in d.extra or line in d.fed:
        return "daily", True
    return "typed_wins", False


def build_ledger(
    db: Session, store_id: int, year: int, month: int,
    summary: MonthlySummary | None,
) -> list[LedgerRow]:
    """Every row of the month, newest day first (rows with no day —
    the return-check line, typed values — last)."""
    if summary is None:
        return []
    start, end = month_bounds(year, month)
    rows: list[LedgerRow] = []
    review: list[Any] = []
    consumed = _bank_rows(db, store_id, start, end, summary, rows, review)
    _suggest(db, store_id, rows, review)
    _daily_rows(db, store_id, start, end, summary, consumed, rows)
    _other_rows(summary, rows)
    rows.sort(key=lambda r: (
        r.day is None, -(r.day.toordinal() if r.day else 0), r.key,
    ))
    return rows


# ── bank ─────────────────────────────────────────────────────


def _bank_rows(
    db: Session, store_id: int, start: date, end: date,
    summary: MonthlySummary, out: list[LedgerRow], review: list[Any],
) -> set[int]:
    """Append the month's bank rows; return the daily entry ids they
    stand for (listed once, as the bank row). The rows to review go
    in `review` too, for their suggestions."""
    from api.Modules.BankSync.Models import (
        BankDailyMatch, BankTransaction, StripeBankAccount,
    )
    from api.Modules.BankSync.Services import reconcile
    from api.Modules.BankSync.Services.categories import (
        BANK_CHARGES_PL_FIELD, BANK_PL_CATEGORIES, is_bank_charge_family,
    )
    from api.Modules.BankSync.Services.charges import booking_day_expr
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Monthly.Services import custom_categories
    from api.Modules.Monthly.Services.entry_categories import movable_kinds

    month_items = {
        int(i.id): i for i in db.query(DailyLineItem).filter(
            DailyLineItem.store_id == store_id,
            DailyLineItem.report_date >= start,
            DailyLineItem.report_date <= end,
        )
    }
    matched_rows = db.query(
        BankDailyMatch.bank_transaction_id, BankDailyMatch.daily_line_item_id,
    ).filter(
        BankDailyMatch.store_id == store_id,
        BankDailyMatch.state == reconcile.MATCHED,
    ).all()
    matches: dict[int, list[int]] = {}
    for t, l in matched_rows:
        matches.setdefault(int(t), []).append(int(l))
    linked_to_month = {
        t for t, ls in matches.items() if any(l in month_items for l in ls)
    }
    day = booking_day_expr()
    clauses: list[Any] = [day >= start, day <= end]
    if month_items:
        clauses.append(BankTransaction.daily_line_item_id.in_(list(month_items)))
    if linked_to_month:
        clauses.append(BankTransaction.id.in_(list(linked_to_month)))
    txns = db.query(BankTransaction).filter(
        BankTransaction.store_id == store_id,
        BankTransaction.dismissed_at.is_(None),
        or_(BankTransaction.status.is_(None), BankTransaction.status != "void"),
        or_(*clauses),
    ).all()
    accts = {
        int(a.id): a.label for a in db.query(StripeBankAccount).filter(
            StripeBankAccount.store_id == store_id,
        )
    }
    elsewhere = {
        int(t.daily_line_item_id) for t in txns
        if t.daily_line_item_id and int(t.daily_line_item_id) not in month_items
    }
    live_elsewhere = {
        int(i) for (i,) in db.query(DailyLineItem.id).filter(
            DailyLineItem.id.in_(list(elsewhere)),
        )
    } if elsewhere else set()
    review_slugs = set(reconcile._review_slugs())
    kind_lines = _kind_lines()
    on = custom_categories.enabled(db, store_id)
    movable = movable_kinds() if on else {}
    custom = {c.slug: str(c.section) for c in custom_categories.store_categories(db, store_id)} \
        if on else {}
    consumed: set[int] = set()
    for t in txns:
        slug = t.category_slug or ""
        booked = int(t.daily_line_item_id) if t.daily_line_item_id else None
        if booked is not None and booked in month_items:
            linked, status = [booked], "added"
        elif matches.get(int(t.id)):
            linked, status = matches[int(t.id)], "matched"
        else:
            linked, status = [], ""
        cents = int(t.amount_cents or 0)
        row = LedgerRow(
            key=f"bank:{t.id}", source="bank", day=None,
            description=t.description or "", amount=abs(cents) / 100.0,
            line=None, status="", counted=False,
            bank_amount=cents / 100.0, txn_id=int(t.id), category_slug=slug,
            rule_id=int(t.matched_rule_id) if t.matched_rule_id else None,
            account_label=accts.get(int(t.stripe_bank_account_id), ""),
            report_date_override=t.report_date_override,
            bank_date=t.posted_at.date() if t.posted_at else None,
        )
        if linked or booked in live_elsewhere:
            # On the daily book: the daily book's day and line.
            items = [month_items[i] for i in linked if i in month_items]
            if not items:
                continue  # its entry sits in another month
            consumed.update(int(i.id) for i in items)
            row.status = status
            row.day = min(i.report_date for i in items)
            if status == "added":
                row.booked_on = row.day
            row.item_kind = str(items[0].kind)
            line = kind_lines.get(row.item_kind)
            if row.item_kind in movable:
                row.entry_id = int(items[0].id)
                row.entry_category = str(items[0].pl_category or "")
            moved = summary.entry_targets.get(int(items[0].id))
            if moved is not None:
                row.line, row.counted = moved, True
                row.amount = sum(int(i.amount_cents or 0) for i in items) / 100.0
                if moved in custom:
                    row.section = custom[moved]
            elif line is not None:
                row.line = line
                row.amount = sum(int(i.amount_cents or 0) for i in items) / 100.0
                elsewhere_status, counted = _daily_status(summary, line)
                row.counted = counted
                row.status = status if counted else elsewhere_status
            out.append(row)
            continue
        row.day = t.report_date_override or (t.posted_at.date() if t.posted_at else None)
        if row.day is None or not (start <= row.day <= end):
            continue
        source = "rule" if t.matched_rule_id else "person"
        if slug in BANK_PL_CATEGORIES:
            row.line, row.status, row.counted = BANK_PL_CATEGORIES[slug], source, True
        elif is_bank_charge_family(slug):
            row.line, row.status, row.counted = BANK_CHARGES_PL_FIELD, source, True
            row.amount = -cents / 100.0
        elif slug in custom:
            row.line, row.status, row.counted = slug, source, True
            row.section = custom[slug]
        elif not slug or slug in review_slugs:
            row.status = "to_review"
            review.append(t)
        else:
            row.status = "not_in_pl"
        out.append(row)
    return consumed


def _suggest(
    db: Session, store_id: int, rows: list[LedgerRow], review: list[Any],
) -> None:
    from api.Modules.Monthly.Services.suggestions import suggestions_for

    found = suggestions_for(db, store_id, review)
    for r in rows:
        if r.txn_id is not None and r.txn_id in found:
            r.suggested_slug, r.suggested_source = found[r.txn_id]


# ── daily books ──────────────────────────────────────────────


def _daily_rows(
    db: Session, store_id: int, start: date, end: date,
    summary: MonthlySummary, consumed: set[int], out: list[LedgerRow],
) -> None:
    from sqlalchemy import func

    from api.Modules.DailyBook.Models import (
        DailyLineItem, DailyReport, MoneyServiceSummary,
    )
    from api.Modules.StoreBook.Models import StoreDailyEntry

    from api.Modules.Monthly.Services.custom_categories import (
        PREFIX as PLC_PREFIX, enabled,
    )
    from api.Modules.Monthly.Services.entry_categories import (
        history_suggestions, movable_kinds,
    )

    if summary.daily.days == 0:
        return
    kind_lines = _kind_lines()
    line_kind = {line: kind for kind, line in kind_lines.items()}
    on = enabled(db, store_id)
    movable = movable_kinds() if on else {}
    unmoved: list[Any] = []

    def add(*, line: str, amount: float, description: str = "", **kw: Any) -> None:
        if amount == 0:
            return
        status, counted = _daily_status(summary, line)
        out.append(LedgerRow(
            line=line, amount=amount, description=description,
            status=status, counted=counted, **kw,
        ))

    # MSB entries, one row each (the bank-linked ones are already
    # listed as their bank row).
    items_by_day: dict[tuple[date, str], int] = {}
    for i in db.query(DailyLineItem).filter(
        DailyLineItem.store_id == store_id,
        DailyLineItem.report_date >= start,
        DailyLineItem.report_date <= end,
        DailyLineItem.kind.in_(list(kind_lines)),
    ):
        cents = int(i.amount_cents or 0)
        items_by_day[(i.report_date, str(i.kind))] = (
            items_by_day.get((i.report_date, str(i.kind)), 0) + cents
        )
        if int(i.id) in consumed:
            continue
        kind = str(i.kind)
        extra: dict[str, Any] = {}
        if kind in movable:
            extra = {"entry_id": int(i.id), "entry_category": str(i.pl_category or "")}
            if not i.pl_category:
                unmoved.append(i)
        moved = summary.entry_targets.get(int(i.id))
        if moved is not None:
            if cents:
                out.append(LedgerRow(
                    key=f"entry:{i.id}", source="entry", day=i.report_date,
                    description=i.note or "", amount=cents / 100.0, line=moved,
                    status="daily", counted=True, item_kind=kind, book="msb",
                    section="expense" if moved.startswith(PLC_PREFIX) else "",
                    **extra,
                ))
            continue
        add(key=f"entry:{i.id}", source="entry", day=i.report_date,
            description=i.note or "", amount=cents / 100.0,
            line=kind_lines[kind], item_kind=kind, book="msb", **extra)

    # A suggestion for an entry still on its own line: where the
    # store put the last one with the same note.
    found = history_suggestions(db, store_id, unmoved)
    if found:
        for r in out:
            if r.entry_id is not None and r.txn_id is None and r.entry_id in found:
                r.suggested_slug, r.suggested_source = found[r.entry_id], "history"

    # Day figures: what each book has for a line that day, less the
    # entries listed above (an older day typed as one total).
    msb_lines = _book_lines("msb")
    for r in db.query(DailyReport).filter(
        DailyReport.store_id == store_id,
        DailyReport.report_date >= start,
        DailyReport.report_date <= end,
    ):
        for attr, line in msb_lines.items():
            cents = int(getattr(r, f"{attr}_cents", 0) or 0)
            kind = line_kind.get(line) if line in DAILY_DERIVED_FIELDS else None
            if kind is not None:
                cents -= items_by_day.get((r.report_date, kind), 0)
            add(key=f"day:msb:{r.report_date.isoformat()}:{attr}", source="day",
                day=r.report_date, amount=cents / 100.0, line=line,
                item_kind=attr, book="msb")
    store_lines = _book_lines("store")
    for e in db.query(StoreDailyEntry).filter(
        StoreDailyEntry.store_id == store_id,
        StoreDailyEntry.entry_date >= start,
        StoreDailyEntry.entry_date <= end,
    ):
        for attr, line in store_lines.items():
            cents = int(getattr(e, f"{attr}_cents", 0) or 0)
            add(key=f"day:store:{e.entry_date.isoformat()}:{attr}", source="day",
                day=e.entry_date, amount=cents / 100.0, line=line,
                item_kind=attr, book="store")
    service_lines = _book_lines("service")
    for d, svc, cents in db.query(
        MoneyServiceSummary.report_date, MoneyServiceSummary.service,
        func.coalesce(func.sum(MoneyServiceSummary.fees_cents), 0),
    ).filter(
        MoneyServiceSummary.store_id == store_id,
        MoneyServiceSummary.report_date >= start,
        MoneyServiceSummary.report_date <= end,
        MoneyServiceSummary.service.in_(list(service_lines)),
    ).group_by(MoneyServiceSummary.report_date, MoneyServiceSummary.service):
        add(key=f"service:{d.isoformat()}:{svc}", source="service", day=d,
            amount=int(cents or 0) / 100.0, line=service_lines[str(svc)],
            item_kind=str(svc))
    # What the companies charge per money order comes off the fees
    # once for the month (daily_feed._money_order_charges).
    if summary.daily.money_order_charges:
        add(key="money_order_charges", source="money_order_charges", day=None,
            amount=-summary.daily.money_order_charges,
            line="money_order_fees", item_kind=str(summary.daily.money_order_count))


# ── returned checks and typed values ─────────────────────────


def _other_rows(summary: MonthlySummary, out: list[LedgerRow]) -> None:
    rc = summary.return_check_gl
    if rc:
        out.append(LedgerRow(
            key="returned_checks", source="returned_checks", day=None,
            description="", amount=float(rc), line="return_check_gl",
            status="returned_checks", counted=True,
        ))
    d = summary.daily
    fed_elsewhere = (
        set(summary.bank_fed) | set(d.fed) | set(d.derived) | set(d.extra)
        | {"return_check_gl"}
    )
    for line in (*INCOME_FIELDS, *EXPENSE_FIELDS):
        if line in fed_elsewhere or line in DAILY_EXTRA_INCOME:
            continue
        value = float(getattr(summary.row, line, 0) or 0)
        if value:
            out.append(LedgerRow(
                key=f"typed:{line}", source="typed", day=None,
                description="", amount=value, line=line,
                status="typed", counted=True,
            ))


def view_counts(rows: list[LedgerRow]) -> dict[str, int]:
    counts = {v: 0 for v in VIEWS}
    for r in rows:
        counts[r.view] += 1
        counts["all"] += 1
    return counts


# ── the double-count guard ───────────────────────────────────

def daily_twins(db: Session, txn: Any, slug: str) -> list[Any]:
    """Daily book entries that may be the same money as `txn`, when a
    person is about to put it on a P&L line (`slug`, a `pl_*` category
    or a bank charge).

    Tagging the bank row for a rent check to "Rent" while the cashier
    already typed that check as a check expense counts the rent twice.
    So: an entry that can reach the bank on a P&L line (a check
    expense, purchase or payroll — `reconcile.MATCH_RULES`), the same
    amount, inside that kind's match window (a check clears up to 90
    days after it is written), not already tied to a bank row — the
    entries "Same money" can link. Empty unless the store has
    `pl_transactions` on. The categorize endpoint answers 409
    `maybe_in_daily_book` with these until the person says it is
    different money (`force`) or links it (the match endpoint)."""
    from datetime import timedelta

    from sqlalchemy import and_, exists

    from api.Modules.BankSync.Models import BankDailyMatch, BankTransaction
    from api.Modules.BankSync.Services import reconcile
    from api.Modules.BankSync.Services.categories import (
        BANK_PL_CATEGORIES, is_bank_charge_family,
    )
    from api.Modules.BankSync.Services.categorize import bank_date_for
    from api.Modules.DailyBook.Models import DailyLineItem

    from api.Modules.Monthly.Services.custom_categories import category_id

    if not (
        slug in BANK_PL_CATEGORIES or is_bank_charge_family(slug)
        or category_id(slug) is not None
    ):
        return []
    store_id = int(txn.store_id)
    if not pl_transactions_enabled(db, store_id):
        return []
    cents = int(txn.amount_cents or 0)
    if cents == 0:
        return []
    pl_kinds = set(_kind_lines())
    rules = [
        r for r in reconcile.MATCH_RULES.values()
        if r.line_kind in pl_kinds and r.credit == (cents > 0)
    ]
    if not rules:
        return []
    day = bank_date_for(txn)
    windows = [
        and_(
            DailyLineItem.kind == r.line_kind,
            DailyLineItem.report_date >= day - timedelta(days=r.after),
            DailyLineItem.report_date <= day + timedelta(days=r.before),
        )
        for r in rules
    ]
    return list(
        db.query(DailyLineItem).filter(
            DailyLineItem.store_id == store_id,
            DailyLineItem.amount_cents == abs(cents),
            or_(*windows),
            ~exists().where(BankTransaction.daily_line_item_id == DailyLineItem.id),
            ~exists().where(
                BankDailyMatch.daily_line_item_id == DailyLineItem.id,
                BankDailyMatch.state == reconcile.MATCHED,
            ),
        ).order_by(DailyLineItem.report_date.desc(), DailyLineItem.id).limit(5)
    )

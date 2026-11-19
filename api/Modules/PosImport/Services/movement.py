"""Gilbarco Passport NAXML-MovementReport parser (G-7).

Besides one PJR journal file per register event, Passport writes a
set of movement reports to the same back-office folder at each
period close. Each file is an ``NAXML-MovementReport`` holding ONE
family:

  FGM  FuelGradeMovement            gallons + dollars per grade,
                                    pump position and price tier
  ISM  ItemSalesMovement            per-item movement
  MCM  MerchandiseCodeMovement      department totals
  MSM  MiscellaneousSummaryMovement payouts, pay-ins, drops, loans,
                                    statistics, totalizers
  TLM  TaxLevelMovement             taxable / exempt / forgiven
                                    sales and tax per tax level
  TPM  TankProductMovement          header only — nothing to keep

Element names come from a live Passport 23.01 site (three business
days, every family; the files are store data and are not in the
repo — tests use synthetic fixtures of the same shape). Facts from
that data the parser and its callers rely on:

* Every family carries the same ``MovementHeader``. BusinessDate,
  BeginDate and BeginTime identify the report; a re-sent report
  replaces its rows (``movement_ingest``), so they are required.
* FGM non-resettable totals belong to the pump POSITION: stated
  once per ``FGMPositionSummary``, repeated by us on every price-tier
  row. They are lifetime meters — never sum them across tiers.
* An MSM row without a ``MiscellaneousSummarySubCodeModifier`` is
  the subtotal of the rows of the same code / sub code that have
  one (payouts / vendorPay: one subtotal + one row per payout).
  Sum the leaves or use the subtotal, never both. Other codes
  repeat a leaf verbatim (two identical totalizer / sales rows), so
  no MSM family can be summed wholesale.
* Money may omit the leading zero (``.99``, ``-.99``).

Paths below are DIRECT child paths from the element being read (not
``.//`` searches as in ``naxml``): the movement families reuse the
same leaf names (``SalesAmount``, ``DiscountAmount``) at several
depths, and a descendant search would silently read the wrong one.

Input is untrusted (it comes from the store) — parsed only through
defusedxml. Money becomes integer cents; volumes and quantities
stay floats (same rule as the journal parser).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, time
from decimal import Decimal, InvalidOperation
from typing import Any, Callable
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as SafeET

from api.Core.Money import to_cents
from api.Modules.PosImport.Services.naxml import PosJournalParseError

# PosJournalFile.event_kind for a staged movement report. Every
# reader of staged journal files skips it — a movement report is
# never a register event.
MOVEMENT_KIND = "movement"

# Family element → the code Passport uses as the file prefix.
FAMILIES: dict[str, str] = {
    "FuelGradeMovement": "FGM",
    "ItemSalesMovement": "ISM",
    "MerchandiseCodeMovement": "MCM",
    "MiscellaneousSummaryMovement": "MSM",
    "TaxLevelMovement": "TLM",
    "TankProductMovement": "TPM",
}


class MovementParseError(PosJournalParseError):
    """A movement report that could not be read (message is
    user-safe). ``business_date`` is set when the header was read,
    so the staged file can still be shown under its day."""

    def __init__(
        self, message: str, *, family: str = "",
        business_date: date | None = None,
    ) -> None:
        super().__init__(message)
        self.family = family
        self.business_date = business_date


@dataclass(frozen=True)
class MovementHeader:
    """The report's MovementHeader, named as the table columns."""

    report_sequence_number: int
    primary_report_period: int
    secondary_report_period: int
    business_date: date
    begin_date: date
    begin_time: time
    end_date: date | None
    end_time: time | None

    def columns(self) -> dict[str, Any]:
        return asdict(self)

    def key(self) -> dict[str, Any]:
        """The report's identity within a store and family — what a
        re-sent copy of the same report shares."""
        return {
            "business_date": self.business_date,
            "begin_date": self.begin_date,
            "begin_time": self.begin_time,
            "primary_report_period": self.primary_report_period,
            "secondary_report_period": self.secondary_report_period,
        }


@dataclass
class MovementReport:
    family: str                     # FGM / ISM / MCM / MSM / TLM / TPM
    header: MovementHeader
    # One dict per stored row, keyed by the family table's column
    # names (header columns excluded). Empty for TPM.
    rows: list[dict[str, Any]] = field(default_factory=list)


# ── Value readers ──────────────────────────────────────────


def _text(el: Element | None, path: str, limit: int = 0) -> str:
    if el is None:
        return ""
    found = el.find(path)
    if found is None or found.text is None:
        return ""
    value = found.text.strip()
    return value[:limit] if limit else value


def _cents(el: Element | None, path: str) -> int:
    raw = _text(el, path)
    if not raw:
        return 0
    try:
        return to_cents(raw)
    except ValueError:
        raise PosJournalParseError(f"Bad money value {raw!r} in <{path}>")


def _decimal(el: Element | None, path: str) -> Decimal:
    raw = _text(el, path)
    if not raw:
        return Decimal(0)
    try:
        value = Decimal(raw)
    except InvalidOperation:
        raise PosJournalParseError(f"Bad numeric value {raw!r} in <{path}>")
    if not value.is_finite():
        raise PosJournalParseError(f"Bad numeric value {raw!r} in <{path}>")
    return value


def _number(el: Element | None, path: str) -> float:
    return float(_decimal(el, path))


def _count(el: Element | None, path: str) -> int:
    return int(_decimal(el, path).to_integral_value())


def _date(el: Element | None, path: str) -> date | None:
    raw = _text(el, path)
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        raise PosJournalParseError(f"Bad date {raw!r} in <{path}>")


def _time(el: Element | None, path: str) -> time | None:
    raw = _text(el, path)
    if not raw:
        return None
    try:
        return time.fromisoformat(raw[:8])
    except ValueError:
        raise PosJournalParseError(f"Bad time {raw!r} in <{path}>")


def _strip_namespaces(root: Element) -> None:
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]


# ── Header ─────────────────────────────────────────────────


def _header(family_el: Element) -> MovementHeader:
    h = family_el.find("MovementHeader")
    if h is None:
        raise PosJournalParseError("Movement report has no MovementHeader.")
    business_date = _date(h, "BusinessDate")
    begin_date = _date(h, "BeginDate")
    begin_time = _time(h, "BeginTime")
    if business_date is None or begin_date is None or begin_time is None:
        # Without these a re-sent report could not replace itself.
        raise PosJournalParseError(
            "Movement report header needs BusinessDate, BeginDate "
            "and BeginTime.",
        )
    return MovementHeader(
        report_sequence_number=_count(h, "ReportSequenceNumber"),
        primary_report_period=_count(h, "PrimaryReportPeriod"),
        secondary_report_period=_count(h, "SecondaryReportPeriod"),
        business_date=business_date,
        begin_date=begin_date,
        begin_time=begin_time,
        end_date=_date(h, "EndDate"),
        end_time=_time(h, "EndTime"),
    )


# ── Families ───────────────────────────────────────────────


def _fgm_rows(family_el: Element) -> list[dict[str, Any]]:
    """One row per price tier. A position summary with no tier still
    yields one row so its meter reading is kept. A detail with no
    position summary is read as one position-less summary."""
    rows: list[dict[str, Any]] = []
    for detail in family_el.findall("FGMDetail"):
        grade = _text(detail, "FuelGradeID", 10)
        for pos in detail.findall("FGMPositionSummary") or [detail]:
            meter = pos.find("FGMNonResettableTotal")
            base = {
                "fuel_grade_id": grade,
                "fuel_position_id": _text(pos, "FuelPositionID", 10),
                "non_resettable_total_volume": _number(
                    meter, "FuelGradeNonResettableTotalVolume",
                ),
                "non_resettable_total_amount_cents": _cents(
                    meter, "FuelGradeNonResettableTotalAmount",
                ),
            }
            tiers: list[Element | None] = list(
                pos.findall("FGMPriceTierSummary"),
            ) or [None]
            for tier in tiers:
                totals = tier.find("FGMSalesTotals") if tier is not None else None
                pump_test = (
                    totals.find("PumpTestTotals") if totals is not None else None
                )
                rows.append({
                    **base,
                    "price_tier_code": _text(tier, "PriceTierCode", 10),
                    "sales_volume": _number(totals, "FuelGradeSalesVolume"),
                    "sales_amount_cents": _cents(totals, "FuelGradeSalesAmount"),
                    "pump_test_amount_cents": _cents(pump_test, "PumpTestAmount"),
                    "pump_test_volume": _number(pump_test, "PumpTestVolume"),
                    "tax_exempt_sales_volume": _number(
                        totals, "TaxExemptSalesVolume",
                    ),
                    "discount_amount_cents": _cents(totals, "DiscountAmount"),
                    "discount_count": _count(totals, "DiscountCount"),
                    "dispenser_discount_amount_cents": _cents(
                        totals, "DispenserDiscountAmount",
                    ),
                    "dispenser_discount_count": _count(
                        totals, "DispenserDiscountCount",
                    ),
                })
    return rows


def _sales_totals(totals: Element | None) -> dict[str, Any]:
    """The discount / promotion / refund / sales block ISM and MCM
    share."""
    return {
        "discount_amount_cents": _cents(totals, "DiscountAmount"),
        "discount_count": _count(totals, "DiscountCount"),
        "promotion_amount_cents": _cents(totals, "PromotionAmount"),
        "promotion_count": _count(totals, "PromotionCount"),
        "refund_amount_cents": _cents(totals, "RefundAmount"),
        "refund_count": _count(totals, "RefundCount"),
        "sales_quantity": _number(totals, "SalesQuantity"),
        "sales_amount_cents": _cents(totals, "SalesAmount"),
        "transaction_count": _count(totals, "TransactionCount"),
    }


def _ism_rows(family_el: Element) -> list[dict[str, Any]]:
    """One row per sell price an item moved at."""
    rows: list[dict[str, Any]] = []
    for detail in family_el.findall("ISMDetail"):
        fmt_el = detail.find("ItemCode/POSCodeFormat")
        base = {
            "pos_code_format": (
                (fmt_el.get("format") or "")[:20] if fmt_el is not None else ""
            ),
            "pos_code": _text(detail, "ItemCode/POSCode", 30),
            "pos_code_modifier": _text(detail, "ItemCode/POSCodeModifier", 20),
            "item_id": _text(detail, "ItemID", 50),
            "description": _text(detail, "Description", 160),
            "merchandise_code": _text(detail, "MerchandiseCode", 20),
            "selling_units": _text(detail, "SellingUnits", 20),
        }
        prices: list[Element | None] = list(
            detail.findall("ISMSellPriceSummary"),
        ) or [None]
        for price in prices:
            totals = price.find("ISMSalesTotals") if price is not None else None
            rows.append({
                **base,
                "actual_sales_price_cents": _cents(price, "ActualSalesPrice"),
                **_sales_totals(totals),
            })
    return rows


def _mcm_rows(family_el: Element) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for detail in family_el.findall("MCMDetail"):
        totals = detail.find("MCMSalesTotals")
        rows.append({
            "merchandise_code": _text(detail, "MerchandiseCode", 20),
            "description": _text(detail, "MerchandiseCodeDescription", 160),
            **_sales_totals(totals),
            "open_dept_sales_amount_cents": _cents(
                totals, "OpenDepartmentSalesAmount",
            ),
            "open_dept_transaction_count": _count(
                totals, "OpenDepartmentTransactionCount",
            ),
        })
    return rows


def _msm_rows(family_el: Element) -> list[dict[str, Any]]:
    """One row per MSMDetail, in file order (a subtotal precedes the
    rows it adds up). The modifier is None when the element is
    absent — that absence is what marks a subtotal."""
    rows: list[dict[str, Any]] = []
    for detail in family_el.findall("MSMDetail"):
        codes = detail.find("MiscellaneousSummaryCodes")
        modifier_el = (
            codes.find("MiscellaneousSummarySubCodeModifier")
            if codes is not None else None
        )
        totals = detail.find("MSMSalesTotals")
        rows.append({
            "summary_code": _text(codes, "MiscellaneousSummaryCode", 50),
            "summary_sub_code": _text(codes, "MiscellaneousSummarySubCode", 50),
            "summary_sub_code_modifier": (
                None if modifier_el is None
                else (modifier_el.text or "").strip()[:50]
            ),
            "tender_code": _text(totals, "Tender/TenderCode", 30),
            "tender_sub_code": _text(totals, "Tender/TenderSubCode", 30),
            "summary_amount_cents": _cents(totals, "MiscellaneousSummaryAmount"),
            "summary_count": _number(totals, "MiscellaneousSummaryCount"),
        })
    return rows


def _tlm_rows(family_el: Element) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for detail in family_el.findall("TLMDetail"):
        rows.append({
            "tax_level_id": _text(detail, "TaxLevelID", 20),
            "merchandise_code": _text(detail, "MerchandiseCode", 20),
            "taxable_sales_amount_cents": _cents(detail, "TaxableSalesAmount"),
            "taxable_sales_refunded_cents": _cents(
                detail, "TaxableSalesRefundedAmount",
            ),
            "tax_collected_amount_cents": _cents(detail, "TaxCollectedAmount"),
            "tax_exempt_sales_amount_cents": _cents(
                detail, "TaxExemptSalesAmount",
            ),
            "tax_exempt_refunded_cents": _cents(
                detail, "TaxExemptSalesRefundedAmount",
            ),
            "tax_forgiven_sales_cents": _cents(detail, "TaxForgivenSalesAmount"),
            "tax_forgiven_refunded_cents": _cents(
                detail, "TaxForgivenSalesRefundedAmount",
            ),
            "tax_refunded_amount_cents": _cents(detail, "TaxRefundedAmount"),
        })
    return rows


def _no_rows(family_el: Element) -> list[dict[str, Any]]:
    return []


_ROW_PARSERS: dict[str, Callable[[Element], list[dict[str, Any]]]] = {
    "FGM": _fgm_rows,
    "ISM": _ism_rows,
    "MCM": _mcm_rows,
    "MSM": _msm_rows,
    "TLM": _tlm_rows,
    "TPM": _no_rows,
}


# ── Entry point ────────────────────────────────────────────


def parse_movement_report(data: bytes | str) -> MovementReport | None:
    """Parse one movement report file.

    Returns None when the bytes are not a movement report at all
    (not XML, or another document such as a PJR journal) — the
    caller then tries the journal parser, which owns those errors.
    Raises ``MovementParseError`` for a movement report it cannot
    read."""
    if isinstance(data, str):
        data = data.encode("ISO-8859-1", errors="replace")
    try:
        root = SafeET.fromstring(data)
    except Exception:
        return None
    _strip_namespaces(root)
    if "MovementReport" not in (root.tag or ""):
        return None

    family_el = next((c for c in root if c.tag in FAMILIES), None)
    if family_el is None:
        found = ", ".join(
            c.tag for c in root if c.tag != "TransmissionHeader"
        ) or "none"
        raise MovementParseError(
            f"Movement report family not supported ({found[:80]}).",
        )
    family = FAMILIES[family_el.tag]
    try:
        header = _header(family_el)
    except PosJournalParseError as exc:
        raise MovementParseError(str(exc), family=family)
    try:
        rows = _ROW_PARSERS[family](family_el)
    except PosJournalParseError as exc:
        raise MovementParseError(
            f"{family}: {exc}", family=family,
            business_date=header.business_date,
        )
    return MovementReport(family=family, header=header, rows=rows)


__all__ = [
    "FAMILIES", "MOVEMENT_KIND", "MovementHeader", "MovementParseError",
    "MovementReport", "parse_movement_report",
]

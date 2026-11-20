"""PosImport — Models.

``PosMerchandiseMap`` is the operator's one-time mapping from the
POS's numeric merchandise (department) codes to the store's own
Department catalog. Gilbarco journals identify departments only
by number ("4", "1024"); what those numbers MEAN is site
configuration the operator owns — same product principle as the
catalogs themselves (HANDOFF.md §2). Commit refuses to book a day
while any code present in the data is unmapped, so the mapping
review is a hard gate, not a silent default.
"""
from __future__ import annotations

from datetime import date, time

from sqlalchemy import (
    BigInteger, Boolean, Column, Date, DateTime, Float, ForeignKey,
    Index, Integer, LargeBinary, String, Time, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, declared_attr, mapped_column, relationship

from api.Core.Database import Base
from api.Core.Clock import utc_now


class PosMerchandiseMap(Base):
    __tablename__ = "retail_pos_merchandise_map"
    id                = Column(Integer, primary_key=True)
    store_id          = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    merchandise_code  = Column(String(20), nullable=False)
    department_id     = Column(
        Integer, ForeignKey("retail_department.id"), nullable=False,
    )
    created_at        = Column(DateTime, default=utc_now)
    __table_args__ = (
        UniqueConstraint("store_id", "merchandise_code"),
    )

    department = relationship("Department")


class PosAgentCredential(Base):
    """API key for a site agent (the folder watcher installed at
    the store). The raw key ("pak_…") is shown exactly once at
    creation and stored only as sha256 — same contract as
    password-reset tokens (CLAUDE.md invariant #10). Revoke +
    re-issue instead of editing; ``last_used_at`` powers an
    "agent is alive" indicator."""

    __tablename__ = "retail_pos_agent_credential"
    id           = Column(Integer, primary_key=True)
    store_id     = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    key_hash     = Column(String(64), unique=True, nullable=False)
    label        = Column(String(80), nullable=False, default="")
    created_at   = Column(DateTime, default=utc_now)
    revoked_at   = Column(DateTime, nullable=True)
    last_used_at = Column(DateTime, nullable=True)


class PosAgentPairing(Base):
    """A one-time connect code for DineroBook Manager on a store PC
    (owner, 2026-11-19: nobody at the store types a name or a
    password). Someone with ``day_close.update`` makes it on the
    Register import page; the Manager sends it once and gets the
    store's agent key back. Stored as sha256 only, good for
    ``PAIRING_TTL`` and one use; ``credential_id`` is the key it
    became. ``created_by`` / ``created_by_name`` say who made it (the
    name kept as written, like the audit log)."""

    __tablename__ = "retail_pos_agent_pairing"
    id              = Column(Integer, primary_key=True)
    store_id        = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    code_hash       = Column(String(64), unique=True, nullable=False)
    created_by      = Column(Integer, nullable=True)
    created_by_name = Column(String(120), nullable=False, default="")
    created_at      = Column(DateTime, default=utc_now)
    expires_at      = Column(DateTime, nullable=False)
    used_at         = Column(DateTime, nullable=True)
    credential_id   = Column(Integer, ForeignKey("retail_pos_agent_credential.id"), nullable=True)


class PosJournalFile(Base):
    """One journal file pushed by a site agent, staged until the
    business day is committed. ``filename`` is unique per store so
    agent retries are idempotent. The gzipped raw XML is kept so
    commits re-parse the original (and future parser fixes can
    re-book history); ~2KB per transaction at c-store volume."""

    __tablename__ = "retail_pos_journal_file"
    id            = Column(Integer, primary_key=True)
    store_id      = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    filename      = Column(String(120), nullable=False)
    business_date = Column(Date, nullable=True, index=True)
    event_kind    = Column(String(16), nullable=False, default="")
    parse_error   = Column(String(255), nullable=False, default="")
    content_gz    = Column(LargeBinary, nullable=False)
    received_at   = Column(DateTime, default=utc_now)
    # ``PjrEvent.prepay_key`` at staging time: on a fuel prepay
    # deposit its own identity, on a completion the identity of the
    # event it restates (so a deposit and its completion share the
    # value), "" on every other file. It is how a day's commit
    # finds a completion staged on a LATER business day without
    # re-parsing every later file. Files staged before the column
    # existed carry "" and are simply not found.
    prepay_key    = Column(String(80), nullable=False, default="")
    __table_args__ = (
        UniqueConstraint("store_id", "filename"),
        Index(
            "ix_retail_pos_journal_file_prepay_key", "store_id", "prepay_key",
        ),
    )


class PosItemDaySale(Base):
    """Per-item net sales for one business day (G-2 — item
    movement). Rebuilt from the staged journal originals at every
    day (re)commit, same self-healing posture as HourlySale.
    ``pos_code`` is the scan code as sold; rows exist whether or
    not the code is in the price book yet (the movement report
    joins opportunistically). Fuel lines are excluded — fuel is
    grade-level volume, not shelf movement."""

    __tablename__ = "retail_pos_item_day_sale"
    id               = Column(Integer, primary_key=True)
    store_id         = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    business_date    = Column(Date, nullable=False, index=True)
    pos_code         = Column(String(30), nullable=False)
    description      = Column(String(160), nullable=False, default="")
    merchandise_code = Column(String(20), nullable=False, default="")
    quantity         = Column(Float, nullable=False, default=0.0)
    amount_cents     = Column(BigInteger, nullable=False, default=0)
    __table_args__ = (
        UniqueConstraint("store_id", "business_date", "pos_code"),
    )


class PosTransaction(Base):
    """One register event, kept as its own row so an operator can
    actually look at a transaction (G-5).

    Until now a PJR file was parsed, rolled into the day's
    aggregates, and the detail discarded — the raw XML stayed in
    ``PosJournalFile`` but nothing could query it. Owners need to
    see what sold on a single ticket, and which tickets were
    refunded or voided, so events are now persisted alongside the
    aggregates they feed.

    These rows are DERIVED, never authored: every (re)commit of a
    business day rebuilds them from the staged originals, the same
    self-healing posture as ``PosItemDaySale`` and ``HourlySale``.
    ``source_file`` is what makes that idempotent — one event per
    file, so re-parsing replaces rather than duplicates.

    Deliberately NOT stored: ``TransmissionHeader``
    (StoreLocationID / VendorName / VendorModelVersion) and the
    report-period header fields. Verified constant across every
    file a live site sends, so they'd be the same value on every
    row forever; the store is already known from ``store_id``.
    """

    __tablename__ = "retail_pos_transaction"
    id            = Column(Integer, primary_key=True)
    store_id      = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    business_date = Column(Date, nullable=False, index=True)
    source_file   = Column(String(120), nullable=False)
    # sale | refund | void | other | financial
    kind          = Column(String(16), nullable=False, default="")
    register_id   = Column(String(20), nullable=False, default="")
    cashier_id    = Column(String(20), nullable=False, default="")
    till_id       = Column(String(20), nullable=False, default="")
    transaction_no = Column(String(30), nullable=False, default="")
    event_sequence_id = Column(String(20), nullable=False, default="")
    started_at    = Column(DateTime, nullable=True)
    ended_at      = Column(DateTime, nullable=True)
    receipt_at    = Column(DateTime, nullable=True)
    event_hour    = Column(Integer, nullable=True)
    outside       = Column(Boolean, nullable=False, default=False)
    training_mode = Column(Boolean, nullable=False, default=False)
    offline       = Column(Boolean, nullable=False, default=False)
    suspended     = Column(Boolean, nullable=False, default=False)
    gross_cents   = Column(BigInteger, nullable=False, default=0)
    net_cents     = Column(BigInteger, nullable=False, default=0)
    tax_cents     = Column(BigInteger, nullable=False, default=0)
    grand_total_cents = Column(BigInteger, nullable=False, default=0)
    # True when ANY line on the event is status="cancel" — lets the
    # list flag "has a voided item" without joining the lines.
    has_voided_line = Column(Boolean, nullable=False, default=False)
    # Fuel prepay (naxml module docstring). A completion carries the
    # deposit it restates (Passport's LinkedTransactionInfo). A
    # deposit whose sale / refund completion exists is ``superseded``:
    # kept so the viewer shows it, left out of every money total.
    # ``superseded_by_file`` names the completion by its file, not
    # its id — a day rebuild re-creates rows with new ids, and the
    # two halves can sit on different business days.
    linked_reason         = Column(String(30), nullable=False, default="")
    linked_register_id    = Column(String(20), nullable=False, default="")
    linked_transaction_no = Column(String(30), nullable=False, default="")
    linked_started_at     = Column(DateTime, nullable=True)
    superseded            = Column(Boolean, nullable=False, default=False)
    superseded_by_file    = Column(String(120), nullable=False, default="")
    __table_args__ = (
        UniqueConstraint("store_id", "source_file"),
    )

    lines = relationship(
        "PosTransactionLine", back_populates="transaction",
        cascade="all, delete-orphan",
    )
    tenders = relationship(
        "PosTransactionTender", back_populates="transaction",
        cascade="all, delete-orphan",
    )


class PosTransactionLine(Base):
    """One item or fuel line on a transaction.

    ``status`` carries the register's own TransactionLine status:
    ``normal`` or ``cancel``. Cancelled lines are STORED — a voided
    item is exactly what an owner wants to see — and every money
    rollup filters them out. Reading these rows for a total without
    filtering on status would inflate it.
    """

    __tablename__ = "retail_pos_transaction_line"
    id             = Column(Integer, primary_key=True)
    transaction_id = Column(
        Integer, ForeignKey("retail_pos_transaction.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    store_id       = Column(Integer, nullable=False, index=True)
    business_date  = Column(Date, nullable=False, index=True)
    line_seq       = Column(Integer, nullable=False, default=0)
    status         = Column(String(10), nullable=False, default="normal")
    pos_code       = Column(String(30), nullable=False, default="")
    pos_code_format = Column(String(20), nullable=False, default="")
    description    = Column(String(160), nullable=False, default="")
    entry_method   = Column(String(20), nullable=False, default="")
    merchandise_code = Column(String(20), nullable=False, default="")
    selling_units  = Column(String(20), nullable=False, default="")
    tax_level_id   = Column(String(20), nullable=False, default="")
    quantity       = Column(Float, nullable=False, default=0.0)
    amount_cents   = Column(BigInteger, nullable=False, default=0)
    actual_price_cents  = Column(BigInteger, nullable=False, default=0)
    regular_price_cents = Column(BigInteger, nullable=False, default=0)
    is_fuel        = Column(Boolean, nullable=False, default=False)
    fuel_grade_id  = Column(String(10), nullable=False, default="")
    fuel_position  = Column(String(10), nullable=False, default="")
    gallons        = Column(Float, nullable=False, default=0.0)

    transaction = relationship("PosTransaction", back_populates="lines")


class PosTransactionTender(Base):
    """How a transaction was paid. Change back to the customer is a
    negative row with ``is_change`` set, so summing yields net money
    taken in — the same convention the day aggregates use."""

    __tablename__ = "retail_pos_transaction_tender"
    id             = Column(Integer, primary_key=True)
    transaction_id = Column(
        Integer, ForeignKey("retail_pos_transaction.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    store_id      = Column(Integer, nullable=False, index=True)
    business_date = Column(Date, nullable=False, index=True)
    status        = Column(String(10), nullable=False, default="normal")
    code          = Column(String(30), nullable=False, default="")
    sub_code      = Column(String(30), nullable=False, default="")
    amount_cents  = Column(BigInteger, nullable=False, default=0)
    is_change     = Column(Boolean, nullable=False, default=False)

    transaction = relationship("PosTransaction", back_populates="tenders")


# ── Movement reports (G-7) ──────────────────────────────────


class _MovementReportRow:
    """The columns every movement row carries: which store, which
    staged file, and the report's MovementHeader, repeated on each
    row the way the owner's target schema lays them out.

    A report is identified by (store, family, business date, begin
    date + time, report periods). That is the replace key: ingesting
    a report deletes the rows that key already holds, then writes
    its own, so a re-sent file never doubles a total. The periods
    are part of it so a shift report that starts when the day
    starts can never overwrite the day report. ``detail_seq`` is
    the row's position in the file (1-based), which keeps the
    unique constraint below true even when a register repeats a
    detail (MSM does).

    These rows are DERIVED from the raw file kept in
    ``PosJournalFile`` (``event_kind="movement"``). Nothing books
    them into a day total, P&L or daily-entry line yet.
    """

    # Header columns sort first so a table reads like the file:
    # which report, then what it says.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, sort_order=-3)

    @declared_attr
    def store_id(cls) -> Mapped[int]:
        return mapped_column(
            Integer, ForeignKey("tenancy_store.id"), nullable=False,
            sort_order=-2,
        )

    source_file: Mapped[str] = mapped_column(
        String(120), nullable=False, sort_order=-1,
    )
    report_sequence_number: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, sort_order=-1,
    )
    primary_report_period: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, sort_order=-1,
    )
    secondary_report_period: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, sort_order=-1,
    )
    business_date: Mapped[date] = mapped_column(
        Date, nullable=False, sort_order=-1,
    )
    begin_date: Mapped[date] = mapped_column(
        Date, nullable=False, sort_order=-1,
    )
    begin_time: Mapped[time] = mapped_column(
        Time, nullable=False, sort_order=-1,
    )
    end_date: Mapped[date | None] = mapped_column(
        Date, nullable=True, sort_order=-1,
    )
    end_time: Mapped[time | None] = mapped_column(
        Time, nullable=True, sort_order=-1,
    )
    detail_seq: Mapped[int] = mapped_column(
        Integer, nullable=False, sort_order=-1,
    )

    @declared_attr.directive
    def __table_args__(cls) -> tuple[UniqueConstraint, ...]:
        # Leads with store_id + business_date, so it also serves the
        # retention purge and every "one store, one day" read.
        return (
            UniqueConstraint(
                "store_id", "business_date", "begin_date", "begin_time",
                "primary_report_period", "secondary_report_period",
                "detail_seq",
                name=f"uq_{cls.__tablename__}_report_row",
            ),
        )


class PosFuelGradeMovement(_MovementReportRow, Base):
    """FGM — gallons and dollars per fuel grade, pump position and
    price tier.

    One row per ``FGMPriceTierSummary``. The non-resettable totals
    are the pump's lifetime meter for that grade and POSITION; the
    file states them once per position and every tier row repeats
    them. Never sum them across tiers — take one per (grade,
    position). ``PumpTestTotals/ReturnTankID`` is left out on
    purpose.
    """

    __tablename__ = "retail_pos_fuel_grade_movement"
    fuel_grade_id                     = Column(String(10), nullable=False, default="")
    fuel_position_id                  = Column(String(10), nullable=False, default="")
    non_resettable_total_volume       = Column(Float, nullable=False, default=0.0)
    non_resettable_total_amount_cents = Column(BigInteger, nullable=False, default=0)
    price_tier_code                   = Column(String(10), nullable=False, default="")
    sales_volume                      = Column(Float, nullable=False, default=0.0)
    sales_amount_cents                = Column(BigInteger, nullable=False, default=0)
    pump_test_amount_cents            = Column(BigInteger, nullable=False, default=0)
    pump_test_volume                  = Column(Float, nullable=False, default=0.0)
    tax_exempt_sales_volume           = Column(Float, nullable=False, default=0.0)
    discount_amount_cents             = Column(BigInteger, nullable=False, default=0)
    discount_count                    = Column(Integer, nullable=False, default=0)
    dispenser_discount_amount_cents   = Column(BigInteger, nullable=False, default=0)
    dispenser_discount_count          = Column(Integer, nullable=False, default=0)


class PosMerchandiseCodeMovement(_MovementReportRow, Base):
    """MCM — the register's own department totals, one row per
    ``MCMDetail``."""

    __tablename__ = "retail_pos_merchandise_code_movement"
    merchandise_code             = Column(String(20), nullable=False, default="")
    description                  = Column(String(160), nullable=False, default="")
    discount_amount_cents        = Column(BigInteger, nullable=False, default=0)
    discount_count               = Column(Integer, nullable=False, default=0)
    promotion_amount_cents       = Column(BigInteger, nullable=False, default=0)
    promotion_count              = Column(Integer, nullable=False, default=0)
    refund_amount_cents          = Column(BigInteger, nullable=False, default=0)
    refund_count                 = Column(Integer, nullable=False, default=0)
    sales_quantity               = Column(Float, nullable=False, default=0.0)
    sales_amount_cents           = Column(BigInteger, nullable=False, default=0)
    transaction_count            = Column(Integer, nullable=False, default=0)
    open_dept_sales_amount_cents = Column(BigInteger, nullable=False, default=0)
    open_dept_transaction_count  = Column(Integer, nullable=False, default=0)


class PosItemSalesMovement(_MovementReportRow, Base):
    """ISM — per-item movement straight from the register. One row
    per ``ISMSellPriceSummary``: an item sold at two prices in the
    period is two rows, so the item's totals are the sum of its
    rows."""

    __tablename__ = "retail_pos_item_sales_movement"
    pos_code_format          = Column(String(20), nullable=False, default="")
    pos_code                 = Column(String(30), nullable=False, default="")
    pos_code_modifier        = Column(String(20), nullable=False, default="")
    item_id                  = Column(String(50), nullable=False, default="")
    description              = Column(String(160), nullable=False, default="")
    merchandise_code         = Column(String(20), nullable=False, default="")
    selling_units            = Column(String(20), nullable=False, default="")
    actual_sales_price_cents = Column(BigInteger, nullable=False, default=0)
    sales_quantity           = Column(Float, nullable=False, default=0.0)
    sales_amount_cents       = Column(BigInteger, nullable=False, default=0)
    discount_amount_cents    = Column(BigInteger, nullable=False, default=0)
    discount_count           = Column(Integer, nullable=False, default=0)
    promotion_amount_cents   = Column(BigInteger, nullable=False, default=0)
    promotion_count          = Column(Integer, nullable=False, default=0)
    refund_amount_cents      = Column(BigInteger, nullable=False, default=0)
    refund_count             = Column(Integer, nullable=False, default=0)
    transaction_count        = Column(Integer, nullable=False, default=0)


class PosMiscSummaryMovement(_MovementReportRow, Base):
    """MSM — payouts, pay-ins, safe drops and loans, statistics,
    totalizers: one row per ``MSMDetail``.

    ``summary_sub_code_modifier`` is NULL when the file has no
    modifier element. Where a (code, sub code, tender) has both
    kinds, the row WITHOUT a modifier is the subtotal of the rows
    WITH one: payouts / vendorPay arrives as one subtotal plus one
    row per payout. Sum the leaves or take the subtotal, never both
    (``movement_ingest.msm_roles`` marks which is which) — adding
    every row doubles it.
    """

    __tablename__ = "retail_pos_misc_summary_movement"
    summary_code              = Column(String(50), nullable=False, default="")
    summary_sub_code          = Column(String(50), nullable=False, default="")
    summary_sub_code_modifier = Column(String(50), nullable=True)
    tender_code               = Column(String(30), nullable=False, default="")
    tender_sub_code           = Column(String(30), nullable=False, default="")
    summary_amount_cents      = Column(BigInteger, nullable=False, default=0)
    # A count, but fuel rows carry gallons here (3 decimals).
    summary_count             = Column(Float, nullable=False, default=0.0)


class PosTaxLevelMovement(_MovementReportRow, Base):
    """TLM — taxable, exempt and forgiven sales and the tax
    collected, one row per ``TLMDetail`` (tax level)."""

    __tablename__ = "retail_pos_tax_level_movement"
    tax_level_id                 = Column(String(20), nullable=False, default="")
    merchandise_code             = Column(String(20), nullable=False, default="")
    taxable_sales_amount_cents   = Column(BigInteger, nullable=False, default=0)
    taxable_sales_refunded_cents = Column(BigInteger, nullable=False, default=0)
    tax_collected_amount_cents   = Column(BigInteger, nullable=False, default=0)
    tax_exempt_sales_amount_cents = Column(BigInteger, nullable=False, default=0)
    tax_exempt_refunded_cents    = Column(BigInteger, nullable=False, default=0)
    tax_forgiven_sales_cents     = Column(BigInteger, nullable=False, default=0)
    tax_forgiven_refunded_cents  = Column(BigInteger, nullable=False, default=0)
    tax_refunded_amount_cents    = Column(BigInteger, nullable=False, default=0)


__all__ = [
    "PosAgentCredential", "PosFuelGradeMovement", "PosItemDaySale",
    "PosItemSalesMovement", "PosJournalFile", "PosMerchandiseCodeMovement",
    "PosMerchandiseMap", "PosMiscSummaryMovement", "PosTaxLevelMovement",
    "PosTransaction", "PosTransactionLine", "PosTransactionTender",
]

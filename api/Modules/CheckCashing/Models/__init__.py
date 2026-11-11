"""Check cashing — Models.

A standalone module (owner, 2026-11-07): it keeps its own customers,
companies and settings and touches no other part of the software —
not the daily book, the monthly P&L, Returned checks or the Transfers
customer list. Connections come later, as a separate decision.

Behind the opt-in ``check_desk`` feature flag (off until a store is
switched on). See this module's ``INVARIANTS.md``.

* ``CheckCashingSettings`` — one row per store: the default fee, the
  optional base charge and what an expired ID does.
* ``CheckCustomer``        — a person who cashes checks. Pinned to the
  store that added them, shared across that store's owner umbrella.
* ``CheckCustomerId``      — one identity document of a customer (a
  driver license, a passport…). A customer always has at least one.
* ``CheckCompany``         — whoever wrote the check (an employer, a
  government agency…), found by its routing + account numbers.
  Shared across the owner umbrella like customers.
* ``CashedCheck``          — one check brought to the counter: cashed,
  not accepted ("declined") or voided later. Belongs to the store that
  took it, on that store's day.
* ``CheckDevice``          — the one computer a store has activated for
  check cashing (owner, 2026-11-09). Only a hash of the key the
  browser holds is stored; a switched-off computer keeps its row.
* ``CheckPicture``         — a picture: the front or back of a check,
  the front or back of an ID, or the customer's photo. The server
  re-encodes every picture (JPEG, no metadata, size-capped) and keeps
  the bytes in the row for the pilot (owner, 2026-11-09: pictures in
  the cloud until the scanner program can keep them on the store PC).

Money is integer cents. A percent fee is stored in basis points
(1% = 100), so ``fee_value`` is cents for a ``flat`` fee and basis
points for a ``percent`` fee; ``fee_kind`` NULL = no own fee.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Column, Date, DateTime, ForeignKey, Integer, LargeBinary,
    String, Text,
)
from sqlalchemy.orm import deferred, relationship

from api.Core.Clock import utc_now
from api.Core.Database import Base

# Stored values. The SPA shows them through label helpers.
FEE_KINDS = ("percent", "flat")
PARTY_STATUSES = ("normal", "trusted", "blocked")
EXPIRED_ID_MODES = ("warn", "block")
CHECK_STATUSES = ("cashed", "declined", "voided")
# What a picture shows. Check pictures belong to a cashed check, ID
# pictures to one of a customer's IDs, the photo to the customer.
PICTURE_KINDS = ("check_front", "check_back", "id_front", "id_back", "photo")
CHECK_PICTURE_KINDS = ("check_front", "check_back")
ID_PICTURE_KINDS = ("id_front", "id_back")
ID_TYPES = (
    "drivers_license", "state_id", "passport", "matricula",
    "military_id", "other",
)


class CheckCashingSettings(Base):
    __tablename__ = "msb_check_settings"
    id                    = Column(Integer, primary_key=True)
    store_id              = Column(
        Integer, ForeignKey("tenancy_store.id"), nullable=False,
        unique=True, index=True,
    )
    default_fee_kind      = Column(String(10), nullable=False, default="percent")
    default_fee_value     = Column(BigInteger, nullable=False, default=0)
    # Base charge: a check under ``base_charge_under_cents`` pays at
    # least ``base_charge_cents``. Either NULL = no base charge.
    base_charge_cents       = Column(BigInteger, nullable=True)
    base_charge_under_cents = Column(BigInteger, nullable=True)
    # What an expired ID does at Cash a check: warn (default) or block.
    expired_id_mode       = Column(String(10), nullable=False, default="warn")
    updated_by            = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    updated_at            = Column(DateTime, default=utc_now, onupdate=utc_now)
    # (PR 2, added last so the table matches the migrations.)
    # Most one customer may cash in a store day across the owner's
    # stores; above it a manager must approve. NULL = no limit.
    daily_limit_cents     = Column(BigInteger, nullable=True)


class CheckCustomer(Base):
    __tablename__ = "msb_check_customer"
    id            = Column(Integer, primary_key=True)
    store_id      = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    full_name     = Column(String(120), nullable=False)
    dob           = Column(Date, nullable=True)
    phone_country = Column(String(8), nullable=False, default="+1")
    phone_number  = Column(String(40), nullable=False, default="")
    address       = Column(String(255), nullable=False, default="")
    status        = Column(String(10), nullable=False, default="normal")
    status_reason = Column(String(255), nullable=False, default="")
    fee_kind      = Column(String(10), nullable=True)
    fee_value     = Column(BigInteger, nullable=True)
    notes         = Column(Text, nullable=False, default="")
    created_by    = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at    = Column(DateTime, default=utc_now)
    updated_at    = Column(DateTime, default=utc_now, onupdate=utc_now)

    ids = relationship(
        "CheckCustomerId", back_populates="customer",
        order_by="CheckCustomerId.id", cascade="all, delete-orphan",
    )


class CheckCustomerId(Base):
    __tablename__ = "msb_check_customer_id"
    id          = Column(Integer, primary_key=True)
    # The customer's home store, copied so the retention purge can
    # walk this table by ``store_id`` like every other per-store row.
    store_id    = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    customer_id = Column(
        Integer, ForeignKey("msb_check_customer.id"), nullable=False, index=True,
    )
    id_type     = Column(String(20), nullable=False)
    id_number   = Column(String(60), nullable=False)
    # Issuing state or country ("TX", "Mexico").
    issuer      = Column(String(60), nullable=False, default="")
    expires_on  = Column(Date, nullable=True)
    created_at  = Column(DateTime, default=utc_now)

    customer = relationship("CheckCustomer", back_populates="ids")


class CheckCompany(Base):
    __tablename__ = "msb_check_company"
    id             = Column(Integer, primary_key=True)
    store_id       = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    name           = Column(String(160), nullable=False)
    # From the MICR line: 9-digit ABA routing number + the payer's
    # account number. Together they identify the company.
    routing_number = Column(String(9), nullable=False, default="", index=True)
    account_number = Column(String(20), nullable=False, default="")
    address        = Column(String(255), nullable=False, default="")
    phone          = Column(String(40), nullable=False, default="")
    status         = Column(String(10), nullable=False, default="normal")
    status_reason  = Column(String(255), nullable=False, default="")
    fee_kind       = Column(String(10), nullable=True)
    fee_value      = Column(BigInteger, nullable=True)
    notes          = Column(Text, nullable=False, default="")
    created_by     = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at     = Column(DateTime, default=utc_now)
    updated_at     = Column(DateTime, default=utc_now, onupdate=utc_now)


class CashedCheck(Base):
    __tablename__ = "msb_cashed_check"
    id                 = Column(Integer, primary_key=True)
    # The store that took the check, and its business day there.
    store_id           = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    store_day          = Column(Date, nullable=False, index=True)
    customer_id        = Column(
        Integer, ForeignKey("msb_check_customer.id"), nullable=False, index=True,
    )
    company_id         = Column(
        Integer, ForeignKey("msb_check_company.id"), nullable=False, index=True,
    )
    check_number       = Column(String(20), nullable=False, default="")
    check_date         = Column(Date, nullable=True)
    amount_cents       = Column(BigInteger, nullable=False)
    # The fee rule that applied (see ``CheckCashingSettings``) and the
    # fee it gave, then the fee actually charged (the cashier may
    # change it) and the cash handed over.
    fee_kind           = Column(String(10), nullable=True)
    fee_value          = Column(BigInteger, nullable=True)
    fee_suggested_cents = Column(BigInteger, nullable=False, default=0)
    fee_cents          = Column(BigInteger, nullable=False, default=0)
    cash_cents         = Column(BigInteger, nullable=False, default=0)
    # The bottom line of the check as read or typed.
    micr               = Column(String(120), nullable=False, default="")
    status             = Column(String(10), nullable=False, default="cashed")
    # Why it was not accepted.
    reason             = Column(String(255), nullable=False, default="")
    # Warnings the cashier saw and went past, comma-separated codes;
    # ``approved_by`` is the manager when one of them needed approval.
    warnings           = Column(String(255), nullable=False, default="")
    approved_by        = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_by         = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at         = Column(DateTime, default=utc_now)
    voided_by          = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    voided_at          = Column(DateTime, nullable=True)
    void_reason        = Column(String(255), nullable=False, default="")

    customer = relationship("CheckCustomer")
    company = relationship("CheckCompany")


class CheckDevice(Base):
    __tablename__ = "msb_check_device"
    id           = Column(Integer, primary_key=True)
    store_id     = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    # The Admin's name for the computer ("Front counter").
    name         = Column(String(60), nullable=False, default="")
    # sha256 of the key kept in the computer's httpOnly cookie.
    token_hash   = Column(String(64), nullable=False, unique=True, index=True)
    created_by   = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at   = Column(DateTime, default=utc_now)
    last_seen_at = Column(DateTime, nullable=True)
    # Set when another computer is activated or an Admin switches it off.
    revoked_at   = Column(DateTime, nullable=True)
    revoked_by   = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)


class CheckPicture(Base):
    __tablename__ = "msb_check_picture"
    id               = Column(Integer, primary_key=True)
    # The store whose computer took the picture (a customer's pictures
    # move with the customer when the purge rehomes it).
    store_id         = Column(Integer, ForeignKey("tenancy_store.id"), nullable=False, index=True)
    kind             = Column(String(20), nullable=False)
    # Exactly one owner, set by kind; a check picture is uploaded first
    # and joins its check when the check is saved.
    cashed_check_id  = Column(
        Integer, ForeignKey("msb_cashed_check.id"), nullable=True, index=True,
    )
    customer_id      = Column(
        Integer, ForeignKey("msb_check_customer.id"), nullable=True, index=True,
    )
    customer_id_doc_id = Column(
        Integer, ForeignKey("msb_check_customer_id.id"), nullable=True, index=True,
    )
    mime             = Column(String(20), nullable=False, default="image/jpeg")
    width            = Column(Integer, nullable=False, default=0)
    height           = Column(Integer, nullable=False, default=0)
    size_bytes       = Column(Integer, nullable=False, default=0)
    sha256           = Column(String(64), nullable=False, default="")
    # Loaded only when the picture itself is asked for.
    data             = deferred(Column(LargeBinary, nullable=False))
    created_by       = Column(Integer, ForeignKey("tenancy_user.id"), nullable=True)
    created_at       = Column(DateTime, default=utc_now)
    # Set when a newer picture of the same kind takes its place.
    replaced_at      = Column(DateTime, nullable=True)

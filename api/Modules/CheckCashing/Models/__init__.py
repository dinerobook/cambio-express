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

Money is integer cents. A percent fee is stored in basis points
(1% = 100), so ``fee_value`` is cents for a ``flat`` fee and basis
points for a ``percent`` fee; ``fee_kind`` NULL = no own fee.
"""
from __future__ import annotations

from sqlalchemy import (
    BigInteger, Column, Date, DateTime, ForeignKey, Integer, String, Text,
)
from sqlalchemy.orm import relationship

from api.Core.Clock import utc_now
from api.Core.Database import Base

# Stored values. The SPA shows them through label helpers.
FEE_KINDS = ("percent", "flat")
PARTY_STATUSES = ("normal", "trusted", "blocked")
EXPIRED_ID_MODES = ("warn", "block")
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

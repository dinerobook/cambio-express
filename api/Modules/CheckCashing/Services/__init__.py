"""Check cashing — Services.

The only writers of this module's tables. Every function takes the
caller's store id (from the token) and, for customers and companies,
the owner umbrella around it: a regular is known at every store that
shares an owner, the same scope as the Transfers customer list. A row
stays pinned to the store that added it.

Rules live in ``api/Modules/CheckCashing/INVARIANTS.md``.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Query, Session

from api.Core.Clock import utc_now
from api.Core.Sorting import order_by_slug
from api.Modules.Billing.Services.feature_flags import opt_in_flag_enabled
from api.Modules.CheckCashing.Models import (
    CheckCashingSettings, CheckCompany, CheckCustomer, CheckCustomerId,
)
from api.Modules.Customers.Repositories import sibling_store_ids

# Opt-in: off for every store until it is switched on (Platform →
# Feature flags). Declared in ``DEFAULT_FEATURE_FLAGS``.
FEATURE_FLAG = "check_desk"

# What a store reads before it saves its own settings.
DEFAULT_SETTINGS: dict[str, Any] = {
    "default_fee_kind": "percent",
    "default_fee_value": 0,
    "base_charge_cents": None,
    "base_charge_under_cents": None,
    "expired_id_mode": "warn",
    "daily_limit_cents": None,
}


class CheckCashingNotFoundError(LookupError):
    pass


class CheckCashingConflictError(ValueError):
    pass


def module_enabled(db: Session, store_id: int) -> bool:
    return opt_in_flag_enabled(db, store_id, FEATURE_FLAG)


def umbrella(db: Session, store_id: int) -> list[int]:
    """The stores whose customers and companies this store shares."""
    return sibling_store_ids(db, store_id)


def to_hundredths(value: float | None) -> int | None:
    """A fee or money value from the API (percent or dollars) as the
    stored integer (basis points or cents)."""
    return None if value is None else int(round(value * 100))


def from_hundredths(value: int | None) -> float | None:
    return None if value is None else value / 100.0


def aba_routing_valid(routing: str) -> bool:
    """The ABA check digit: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9)
    is a multiple of 10. Catches a mistyped or misread digit."""
    if len(routing) != 9 or not routing.isdigit():
        return False
    d = [int(c) for c in routing]
    total = (
        3 * (d[0] + d[3] + d[6])
        + 7 * (d[1] + d[4] + d[7])
        + (d[2] + d[5] + d[8])
    )
    return total % 10 == 0


def mask(value: str, keep: int = 4) -> str:
    """``"D1234567"`` → ``"••••4567"``. Short values show as stored."""
    value = value or ""
    if len(value) <= keep:
        return value
    return "••••" + value[-keep:]


# ── Settings ───────────────────────────────────────────────


def get_settings(db: Session, store_id: int) -> dict[str, Any]:
    row = db.query(CheckCashingSettings).filter_by(store_id=store_id).first()
    if row is None:
        return dict(DEFAULT_SETTINGS)
    return {
        "default_fee_kind": row.default_fee_kind,
        "default_fee_value": row.default_fee_value,
        "base_charge_cents": row.base_charge_cents,
        "base_charge_under_cents": row.base_charge_under_cents,
        "expired_id_mode": row.expired_id_mode,
        "daily_limit_cents": row.daily_limit_cents,
    }


def save_settings(
    db: Session, store_id: int, data: dict[str, Any], user_id: int | None,
) -> dict[str, Any]:
    row = db.query(CheckCashingSettings).filter_by(store_id=store_id).first()
    if row is None:
        row = CheckCashingSettings(store_id=store_id)
        db.add(row)
    row.default_fee_kind = data["default_fee_kind"]
    row.default_fee_value = to_hundredths(data["default_fee_value"]) or 0
    row.base_charge_cents = to_hundredths(data.get("base_charge"))
    row.base_charge_under_cents = to_hundredths(data.get("base_charge_under"))
    row.expired_id_mode = data["expired_id_mode"]
    row.daily_limit_cents = to_hundredths(data.get("daily_limit"))
    row.updated_by = user_id
    row.updated_at = utc_now()
    db.flush()
    return get_settings(db, store_id)


# ── Customers ──────────────────────────────────────────────

CUSTOMER_SORT_COLUMNS = {
    "name": CheckCustomer.full_name,
    "created": CheckCustomer.created_at,
    "status": CheckCustomer.status,
}


def id_expired(row: CheckCustomerId, today: date) -> bool:
    return row.expires_on is not None and row.expires_on < today


def customers_query(
    db: Session, store_ids: list[int], *, q: str = "", status: str = "",
    sort: str = "", direction: str = "asc",
) -> Query[CheckCustomer]:
    """Customers in the umbrella. ``q`` matches the name, the phone
    number or any ID number."""
    query = db.query(CheckCustomer).filter(CheckCustomer.store_id.in_(store_ids))
    needle = q.strip()
    if needle:
        digits = "".join(c for c in needle if c.isdigit())
        conditions = [
            CheckCustomer.full_name.ilike(f"%{needle}%"),
            CheckCustomer.id.in_(
                db.query(CheckCustomerId.customer_id).filter(
                    CheckCustomerId.store_id.in_(store_ids),
                    CheckCustomerId.id_number.ilike(f"%{needle}%"),
                ),
            ),
        ]
        if len(digits) >= 2:
            conditions.append(CheckCustomer.phone_number.like(f"%{digits}%"))
        query = query.filter(or_(*conditions))
    if status:
        query = query.filter(CheckCustomer.status == status)
    return order_by_slug(
        query, CUSTOMER_SORT_COLUMNS, sort, direction,
        default=(CheckCustomer.full_name, CheckCustomer.id),
        tiebreak=(CheckCustomer.id,),
    )


def get_customer(
    db: Session, store_ids: list[int], customer_id: int,
) -> CheckCustomer:
    row = db.get(CheckCustomer, customer_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Customer not found")
    return row


_CUSTOMER_FIELDS = (
    "full_name", "dob", "phone_country", "address", "status",
    "status_reason", "fee_kind", "notes",
)


def _apply_customer(row: CheckCustomer, data: dict[str, Any]) -> None:
    for field in _CUSTOMER_FIELDS:
        setattr(row, field, data[field])
    row.full_name = data["full_name"].strip()
    row.phone_number = "".join(c for c in data["phone_number"] if c.isdigit())
    row.fee_value = to_hundredths(data["fee_value"])
    if row.status == "normal":
        row.status_reason = ""


def _new_id(customer: CheckCustomer, data: dict[str, Any]) -> CheckCustomerId:
    return CheckCustomerId(
        store_id=customer.store_id,
        id_type=data["id_type"],
        id_number=data["id_number"].strip(),
        issuer=data["issuer"].strip(),
        expires_on=data["expires_on"],
    )


def create_customer(
    db: Session, store_id: int, data: dict[str, Any], user_id: int | None,
) -> CheckCustomer:
    row = CheckCustomer(store_id=store_id, created_by=user_id)
    _apply_customer(row, data)
    for id_data in data["ids"]:
        row.ids.append(_new_id(row, id_data))
    db.add(row)
    db.flush()
    return row


def update_customer(
    db: Session, store_ids: list[int], customer_id: int, data: dict[str, Any],
) -> CheckCustomer:
    row = get_customer(db, store_ids, customer_id)
    _apply_customer(row, data)
    row.updated_at = utc_now()
    db.flush()
    return row


def _customer_id_row(
    customer: CheckCustomer, id_row_id: int,
) -> CheckCustomerId:
    for id_row in customer.ids:
        if id_row.id == id_row_id:
            return id_row
    raise CheckCashingNotFoundError("ID not found")


def add_customer_id(
    db: Session, store_ids: list[int], customer_id: int, data: dict[str, Any],
) -> CheckCustomerId:
    customer = get_customer(db, store_ids, customer_id)
    if len(customer.ids) >= 10:
        raise CheckCashingConflictError("A customer can hold at most 10 IDs.")
    id_row = _new_id(customer, data)
    customer.ids.append(id_row)
    customer.updated_at = utc_now()
    db.flush()
    return id_row


def update_customer_id(
    db: Session, store_ids: list[int], customer_id: int, id_row_id: int,
    data: dict[str, Any],
) -> CheckCustomerId:
    customer = get_customer(db, store_ids, customer_id)
    id_row = _customer_id_row(customer, id_row_id)
    id_row.id_type = data["id_type"]
    id_row.id_number = data["id_number"].strip()
    id_row.issuer = data["issuer"].strip()
    id_row.expires_on = data["expires_on"]
    customer.updated_at = utc_now()
    db.flush()
    return id_row


def delete_customer_id(
    db: Session, store_ids: list[int], customer_id: int, id_row_id: int,
) -> CheckCustomerId:
    """Remove one ID. The last one stays: a customer always has an ID
    on file."""
    customer = get_customer(db, store_ids, customer_id)
    id_row = _customer_id_row(customer, id_row_id)
    if len(customer.ids) <= 1:
        raise CheckCashingConflictError(
            "A customer must keep at least one ID. Add the new ID first.",
        )
    customer.ids.remove(id_row)
    customer.updated_at = utc_now()
    db.flush()
    return id_row


# ── Companies ──────────────────────────────────────────────

COMPANY_SORT_COLUMNS = {
    "name": CheckCompany.name,
    "created": CheckCompany.created_at,
    "status": CheckCompany.status,
}


def companies_query(
    db: Session, store_ids: list[int], *, q: str = "", status: str = "",
    sort: str = "", direction: str = "asc",
) -> Query[CheckCompany]:
    """Companies in the umbrella. ``q`` matches the name or the start
    of the routing or account number."""
    query = db.query(CheckCompany).filter(CheckCompany.store_id.in_(store_ids))
    needle = q.strip()
    if needle:
        query = query.filter(or_(
            CheckCompany.name.ilike(f"%{needle}%"),
            CheckCompany.routing_number.like(f"{needle}%"),
            CheckCompany.account_number.like(f"{needle}%"),
        ))
    if status:
        query = query.filter(CheckCompany.status == status)
    return order_by_slug(
        query, COMPANY_SORT_COLUMNS, sort, direction,
        default=(CheckCompany.name, CheckCompany.id),
        tiebreak=(CheckCompany.id,),
    )


def get_company(
    db: Session, store_ids: list[int], company_id: int,
) -> CheckCompany:
    row = db.get(CheckCompany, company_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Company not found")
    return row


def _check_numbers(
    db: Session, store_ids: list[int], data: dict[str, Any],
    exclude_id: int | None = None,
) -> None:
    routing = data["routing_number"]
    account = data["account_number"]
    if not routing:
        return
    if not aba_routing_valid(routing):
        raise CheckCashingConflictError(
            "That routing number is not valid. Check the 9 digits.",
        )
    q = db.query(CheckCompany).filter(
        CheckCompany.store_id.in_(store_ids),
        CheckCompany.routing_number == routing,
        CheckCompany.account_number == account,
    )
    if exclude_id is not None:
        q = q.filter(CheckCompany.id != exclude_id)
    other = q.first()
    if other is not None:
        raise CheckCashingConflictError(
            f"These routing and account numbers already belong to {other.name}.",
        )


_COMPANY_FIELDS = (
    "routing_number", "account_number", "status", "status_reason",
    "fee_kind", "notes",
)


def _apply_company(row: CheckCompany, data: dict[str, Any]) -> None:
    for field in _COMPANY_FIELDS:
        setattr(row, field, data[field])
    row.name = data["name"].strip()
    row.address = data["address"].strip()
    row.phone = data["phone"].strip()
    row.fee_value = to_hundredths(data["fee_value"])
    if row.status == "normal":
        row.status_reason = ""


def create_company(
    db: Session, store_id: int, store_ids: list[int], data: dict[str, Any],
    user_id: int | None,
) -> CheckCompany:
    _check_numbers(db, store_ids, data)
    row = CheckCompany(store_id=store_id, created_by=user_id)
    _apply_company(row, data)
    db.add(row)
    db.flush()
    return row


def update_company(
    db: Session, store_ids: list[int], company_id: int, data: dict[str, Any],
) -> CheckCompany:
    row = get_company(db, store_ids, company_id)
    _check_numbers(db, store_ids, data, exclude_id=row.id)
    _apply_company(row, data)
    row.updated_at = utc_now()
    db.flush()
    return row

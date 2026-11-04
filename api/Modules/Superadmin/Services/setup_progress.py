"""Setup progress per store — the superadmin's "who is stuck" list.

A new store is set up when it has done four things:

  1. companies   — saved its own money-transfer companies in
                   Settings → Money services (``Store.companies`` is
                   no longer blank, so it is not running on the
                   built-in Intermex / Maxi / Barri fallback);
  2. charges     — set what each company charges per money order
                   (``store_money_order_charges``), for every active
                   company that sells money orders;
  3. bank        — connected a bank account (a ``StripeBankAccount``
                   that is not disconnected);
  4. locked day  — locked its first daily book.

Steps 1 and 2 only apply to a store with the Money services module
on; for the rest they are ``None`` and left out of the count (a step
that does not apply disappears rather than reading "not done"). A
store with no money-order companies has nothing to price, so step 2
is ``None`` there too.

Pure reads, a fixed number of grouped queries whatever the store
count, so the list never fans out per store.
"""
from datetime import date
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func
from sqlalchemy.orm import Session

from api.Core.Clock import local_today
from api.Modules.BankSync.Models import StripeBankAccount
from api.Modules.Billing.Services.feature_flags import stores_feature_enabled
from api.Modules.DailyBook.Models import DailyReport
from api.Modules.Tenancy.Models import Store
from api.Modules.Transfers.Services.companies import (
    store_money_order_charges, store_money_order_companies,
    store_mt_companies,
)

SETUP_STATUSES = ("open", "done", "all")


def _connected_bank_stores(db: Session, store_ids: list[int]) -> set[int]:
    rows = (
        db.query(StripeBankAccount.store_id)
          .filter(
              StripeBankAccount.store_id.in_(store_ids),
              StripeBankAccount.disconnected_at.is_(None),
          )
          .distinct()
    )
    return {int(r.store_id) for r in rows}


def _first_locked_days(db: Session, store_ids: list[int]) -> dict[int, str]:
    rows = (
        db.query(DailyReport.store_id, func.min(DailyReport.report_date))
          .filter(
              DailyReport.store_id.in_(store_ids),
              DailyReport.locked_at.isnot(None),
          )
          .group_by(DailyReport.store_id)
    )
    return {int(sid): day.isoformat() for sid, day in rows if day is not None}


def _local_day(timezone: str, when: Any) -> date | None:
    """The store-local calendar day of a naive-UTC timestamp."""
    if when is None:
        return None
    try:
        zone = ZoneInfo(timezone.strip() or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    day: date = when.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone).date()
    return day


def setup_progress_rows(db: Session, stores: list[Store]) -> list[dict[str, Any]]:
    """One setup row per store, in the order given."""
    if not stores:
        return []
    ids = [int(s.id) for s in stores]
    money = stores_feature_enabled(db, stores, "module_money_services")
    banks = _connected_bank_stores(db, ids)
    locked = _first_locked_days(db, ids)

    rows: list[dict[str, Any]] = []
    for s in stores:
        sid = int(s.id)
        tz = str(s.timezone or "")
        has_money = money.get(sid, True)
        companies_added: bool | None = None
        charges_set: bool | None = None
        company_count = 0
        mo_companies = 0
        mo_priced = 0
        if has_money:
            companies_added = bool((s.companies or "").strip())
            company_count = len(store_mt_companies(s)) if companies_added else 0
            sellers = store_money_order_companies(s)
            charges = store_money_order_charges(s)
            mo_companies = len(sellers)
            mo_priced = sum(1 for c in sellers if c.lower() in charges)
            if mo_companies:
                charges_set = mo_priced == mo_companies
        bank_connected = sid in banks
        first_locked = locked.get(sid)
        steps = [companies_added, charges_set, bank_connected, first_locked is not None]
        applicable = [x for x in steps if x is not None]
        signed_up = _local_day(tz, s.created_at)
        today = local_today(tz) if signed_up else None
        rows.append({
            "store_id": sid,
            "name": s.name or "",
            "slug": s.slug or "",
            "plan": s.plan or "trial",
            "is_active": bool(s.is_active),
            "signed_up_on": signed_up.isoformat() if signed_up else None,
            "days_since_signup": (
                max(0, (today - signed_up).days) if signed_up and today else None
            ),
            "companies_added": companies_added,
            "company_count": company_count,
            "charges_set": charges_set,
            "money_order_companies": mo_companies,
            "money_order_charges_set": mo_priced,
            "bank_connected": bank_connected,
            "first_locked_day": first_locked,
            "steps_done": sum(1 for x in applicable if x),
            "steps_total": len(applicable),
        })
    return rows


def filter_setup_rows(rows: list[dict[str, Any]], status: str) -> list[dict[str, Any]]:
    """``open`` = setup not finished, ``done`` = finished, else all."""
    if status == "open":
        return [r for r in rows if r["steps_done"] < r["steps_total"]]
    if status == "done":
        return [r for r in rows if r["steps_done"] >= r["steps_total"]]
    return rows


__all__ = ["SETUP_STATUSES", "filter_setup_rows", "setup_progress_rows"]

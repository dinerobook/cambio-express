"""Country editor write — header, company columns, banks and rates.

One call saves the whole editor so the board never shows a half-
applied edit. The caller owns the commit (and the audit row that
rides it).
"""
from typing import Any

from sqlalchemy.orm import Session

from api.Modules.TVDisplay.Models import (
    TVDisplayCountry, TVDisplayPayoutBank, TVDisplayRate,
)


def _clean_companies(names: list[str]) -> list[str]:
    """Trimmed, de-duplicated, order kept. Commas would break the
    stored CSV, so they are dropped from a name."""
    out: list[str] = []
    for raw in names:
        name = raw.replace(",", " ").strip()[:80]
        if name and name not in out:
            out.append(name)
    return out


def save_country(
    db: Session, country: TVDisplayCountry, payload: Any,
) -> dict[str, int]:
    """Apply a ``TVDisplayCountryUpdateRequest`` to ``country``.

    Bank ids that do not belong to this country are refused with
    ``ValueError`` (the controller answers 404, the same as an
    unknown id). Rates for a company that is no longer a column are
    dropped, since the board can never show them.
    Returns counts for the audit summary.
    """
    companies = _clean_companies(payload.mt_companies)
    country.country_name = payload.country_name.strip()[:80] or country.country_name
    country.country_code = (payload.country_code or "").strip().upper()[:4]
    country.mt_companies = ",".join(companies)[:500]

    banks = {
        b.id: b for b in
        db.query(TVDisplayPayoutBank)
          .filter(TVDisplayPayoutBank.country_id == country.id)
          .all()
    }
    for edit in payload.banks:
        if edit.id not in banks:
            raise ValueError("bank not in country")

    rates_by_key = {
        (r.bank_id, r.mt_company): r for r in
        db.query(TVDisplayRate)
          .filter(TVDisplayRate.bank_id.in_(list(banks) or [0]))
          .all()
    }
    counts = {"banks_added": 0, "banks_deleted": 0, "rates_set": 0}
    deleted: set[int] = set()

    for edit in payload.banks:
        bank = banks[edit.id]
        if edit.delete:
            (db.query(TVDisplayRate)
               .filter(TVDisplayRate.bank_id == bank.id)
               .delete(synchronize_session=False))
            db.delete(bank)
            deleted.add(bank.id)
            counts["banks_deleted"] += 1
            continue
        bank.bank_name = edit.bank_name.strip()[:120] or bank.bank_name
        bank.sort_order = edit.sort_order
        for company in companies:
            value = edit.rates.get(company)
            existing = rates_by_key.get((bank.id, company))
            if value is None:
                if existing is not None:
                    db.delete(existing)
                continue
            if existing is None:
                db.add(TVDisplayRate(
                    bank_id=bank.id, mt_company=company, rate=float(value),
                ))
            else:
                existing.rate = float(value)
            counts["rates_set"] += 1

    for (bank_id, company), rate in rates_by_key.items():
        if company not in companies and bank_id not in deleted:
            db.delete(rate)

    next_sort = max((b.sort_order or 0 for b in banks.values()), default=0)
    for raw in payload.new_banks:
        name = raw.strip()[:120]
        if not name:
            continue
        next_sort += 10
        db.add(TVDisplayPayoutBank(
            country_id=country.id, bank_name=name, sort_order=next_sort,
        ))
        counts["banks_added"] += 1
    return counts

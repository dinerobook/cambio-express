"""Bank category / slug helpers.

A bank transaction gets tagged with exactly one slug, and the slug
decides where the money lands in the books. Three families:

  1. **Daily-book kinds** (`LINE_ITEM_KINDS`): tagging posts a
     `DailyLineItem` on the day's book — a remote check deposit
     becomes a `check_deposit` line, a utility autopay a
     `cash_expense` line — and the day's total rolls up from there
     exactly as if the cashier had typed it. See `categorize.py`.

  2. **Monthly P&L lines** (`BANK_PL_CATEGORIES`, slugs `pl_*`):
     nothing touches the daily book. The monthly P&L sums these
     transactions straight into the matching `MonthlyFinancial`
     column (credit-card fees, money-order rent, other income…),
     under the same conditional-lock rule as bank charges: while
     the bank has data for a month, the server's sum wins; when it
     has none, the operator's typed value stands.

  3. **Non-posting tags** (`BANK_CATEGORIES_NON_POSTING`): internal
     transfers, the MT ACH debits that the ACH-batch module
     reconciles, "ignore". Bank charges (`bank_charge_<last4>`)
     live here too but DO feed the P&L's `bank_charges_total` via a
     prefix match — they predate the `pl_*` family.

`bank_category_groups` is what the SPA renders; `is_valid_bank_
category` is what the server accepts. Keep them in step.
"""
from sqlalchemy.orm import Session

from api.Modules.DailyBook.Services import LINE_ITEM_KINDS


# Static slugs that don't post to the daily book.
# Static `bank_charge_210 / _230` entries are kept ONLY so the
# Nizari-store dropdown still surfaces them; future banks get
# their slugs added dynamically by `bank_category_groups` via the
# store's connected accounts.
BANK_CATEGORIES_NON_POSTING: dict[str, str] = {
    "internal_transfer":  "Internal transfer",
    "mt_ach_intermex":    "MT ACH — Intermex",
    "mt_ach_maxi":        "MT ACH — Maxi",
    "mt_ach_barri":       "MT ACH — Barri",
    "bank_charge_210":    "Bank charge — ••0210",
    "bank_charge_230":    "Bank charge — ••0230 (MSB)",
    "ignore":             "Ignore (don't reconcile)",
}


# slug → (MonthlyFinancial column, operator label). Every column
# here is operator-editable on the P&L today; tagging bank rows
# with the slug is what turns it into a bank-fed line. Amounts are
# summed as absolutes — the column's sign is decided by which P&L
# bucket it sits in (INCOME_FIELDS / EXPENSE_FIELDS), not by the
# transaction's direction.
BANK_PL_CATEGORIES: dict[str, tuple[str, str]] = {
    # Expenses
    "pl_credit_card_fees":   ("credit_card_fees",   "Credit card fees"),
    "pl_money_order_rent":   ("money_order_rent",   "Money order rent"),
    "pl_emaginenet_tech":    ("emaginenet_tech",    "EmagineNet / tech"),
    "pl_irs_payroll_tax":    ("irs_payroll_tax",    "IRS payroll tax"),
    "pl_texas_workforce":    ("texas_workforce",    "Texas workforce"),
    "pl_other_taxes":        ("other_taxes",        "Other taxes"),
    "pl_accounting_charges": ("accounting_charges", "Accounting charges"),
    "pl_other_expense_1":    ("other_expense_1",    "Other expense 1"),
    "pl_other_expense_2":    ("other_expense_2",    "Other expense 2"),
    "pl_other_expense_3":    ("other_expense_3",    "Other expense 3"),
    "pl_other_expense_4":    ("other_expense_4",    "Other expense 4"),
    "pl_other_expense_5":    ("other_expense_5",    "Other expense 5"),
    # Income
    "pl_mt_commission_in_bank": ("mt_commission_in_bank", "Money transfer commission in bank"),
    "pl_rebates_commissions":   ("rebates_commissions",   "Rebates / commissions"),
    "pl_other_income_1":        ("other_income_1",        "Other income 1"),
    "pl_other_income_2":        ("other_income_2",        "Other income 2"),
    "pl_other_income_3":        ("other_income_3",        "Other income 3"),
}

# The one P&L column that is fed by a slug FAMILY rather than a
# single slug: every `bank_charge`, `bank_charge_210`,
# `bank_charge_<last4>` row rolls into it.
BANK_CHARGES_PL_FIELD = "bank_charges_total"


def is_daily_book_kind(slug: str | None) -> bool:
    """True iff `slug` is a registered DailyBook line-item kind.

    Pure read of the LINE_ITEM_KINDS registry — no DB.
    """
    if not slug:
        return False
    return slug in LINE_ITEM_KINDS


def is_bank_charge_family(slug: str | None) -> bool:
    return bool(slug) and (slug == "bank_charge" or str(slug).startswith("bank_charge_"))


def monthly_field_for(slug: str | None) -> str | None:
    """The MonthlyFinancial column a slug feeds, or None when the
    slug has no P&L effect (daily-book kinds reach the P&L through
    the daily ledger, not directly)."""
    if not slug:
        return None
    if slug in BANK_PL_CATEGORIES:
        return BANK_PL_CATEGORIES[slug][0]
    if is_bank_charge_family(slug):
        return BANK_CHARGES_PL_FIELD
    return None


def bank_category_label(slug: str | None) -> str:
    """Operator-friendly label for a category slug.

    Lookup priority:
      1. `BANK_CATEGORIES_NON_POSTING` static dict.
      2. `BANK_PL_CATEGORIES` → "P&L · <label>".
      3. Dynamic `bank_charge_<last4>` slug → "Bank charge —
         ••<last4>" (so the UI doesn't show the raw slug).
      4. DailyBook line-item kind → titlecase of singular label.
      5. Fall through to the slug itself.

    Empty / None slug returns "Uncategorized".
    """
    if not slug:
        return "Uncategorized"
    if slug in BANK_CATEGORIES_NON_POSTING:
        return BANK_CATEGORIES_NON_POSTING[slug]
    if slug in BANK_PL_CATEGORIES:
        return f"P&L · {BANK_PL_CATEGORIES[slug][1]}"
    # Dynamic per-account bank-charge slug — render uniformly.
    if slug.startswith("bank_charge_"):
        suffix = slug[len("bank_charge_"):]
        if suffix:
            return f"Bank charge — ••{suffix}"
    if slug in LINE_ITEM_KINDS:
        return LINE_ITEM_KINDS[slug][1].title()
    return slug


def _other_options(db: Session, store_id: int | None) -> dict[str, str]:
    other = dict(BANK_CATEGORIES_NON_POSTING)  # copy so we can extend
    if store_id is not None:
        from api.Modules.BankSync.Models import StripeBankAccount
        accounts = (
            db.query(StripeBankAccount)
              .filter_by(store_id=store_id)
              .all()
        )
        for a in accounts:
            if not a.last4:
                continue
            stripped = a.last4.lstrip("0") or a.last4
            slug = f"bank_charge_{stripped}"
            if slug not in other:
                other[slug] = f"Bank charge — ••{a.last4}"
    return other


def bank_category_groups(
    db: Session, store_id: int | None = None,
) -> list[tuple[str, list[tuple[str, str]]]]:
    """Grouped `(group_label, [(slug, label), ...])` tuples for
    dropdowns. Three groups, in the order an operator should read
    them: what posts to today's book, what feeds the month's P&L,
    and what is only a tag.

    When `store_id` is given, the "Other" group is augmented with
    a per-account `bank_charge_<last4>` entry for every connected
    account that isn't already in the static dict — so
    single-account or non-Nizari banks see a relevant bank-charge
    option.
    """
    daily = [
        (slug, meta[1].title())
        for slug, meta in LINE_ITEM_KINDS.items()
    ]
    pl = [(slug, label) for slug, (_field, label) in BANK_PL_CATEGORIES.items()]
    other = _other_options(db, store_id)
    return [
        ("Daily book", daily),
        ("Monthly P&L", pl),
        ("Other (no daily-book impact)", list(other.items())),
    ]


def is_valid_bank_category(
    db: Session, slug: str | None, store_id: int,
) -> bool:
    """True iff `slug` is an acceptable target for a manual
    bank-transaction tag or a `BankRule`.

    Accepts every slug surfaced in `bank_category_groups(store_id)`,
    including dynamic `bank_charge_<last4>` for the store's
    connected accounts.
    """
    if not slug:
        return False
    if (
        slug in LINE_ITEM_KINDS
        or slug in BANK_CATEGORIES_NON_POSTING
        or slug in BANK_PL_CATEGORIES
    ):
        return True
    # Dynamic per-account bank-charge: validate against the store's
    # connected account set.
    if slug.startswith("bank_charge_"):
        last4 = slug[len("bank_charge_"):]
        if not last4:
            return False
        from api.Modules.BankSync.Models import StripeBankAccount
        accounts = (
            db.query(StripeBankAccount)
              .filter_by(store_id=store_id)
              .all()
        )
        for a in accounts:
            if not a.last4:
                continue
            stripped = a.last4.lstrip("0") or a.last4
            if last4 == stripped or last4 == a.last4:
                return True
    return False

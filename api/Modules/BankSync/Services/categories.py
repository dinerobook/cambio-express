"""Bank category / slug helpers.

A bank transaction gets tagged with exactly one slug, and the slug
decides where the money lands in the books. Three families:

  1. **Daily-book kinds** (`LINE_ITEM_KINDS`): tagging posts a
     `DailyLineItem` on the day's book — a remote check deposit
     becomes a `check_deposit` line, a utility autopay a
     `cash_expense` line — and the day's total rolls up from there
     exactly as if the cashier had typed it. See `categorize.py`.
     These say how the money MOVED, so they are platform-owned and
     not renameable.

  2. **Monthly P&L lines** (`BANK_PL_CATEGORIES`, slugs `pl_*`):
     nothing touches the daily book. The monthly P&L sums these
     transactions straight into the matching `MonthlyFinancial`
     column (credit-card fees, money-order rent, other income…),
     under the same conditional-lock rule as bank charges: while
     the bank has data for a month, the server's sum wins; when it
     has none, the operator's typed value stands. These say what
     the money was FOR, so the store names them —
     `Monthly.Services.labels` owns the names and this module only
     renders them.

  3. **Non-posting tags** (`BANK_CATEGORIES_NON_POSTING`): internal
     transfers, the MT ACH debits that the ACH-batch module
     reconciles, "ignore". Bank charges (`bank_charge_<last4>`)
     live here too but DO feed the P&L's `bank_charges_total` via a
     prefix match — they predate the `pl_*` family.

`bank_category_groups` is what the SPA renders; `is_valid_bank_
category` is what the server accepts. They used to be two parallel
lists and drifted; now the second is defined as "in the first", so
they cannot.
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


# slug → the `MonthlyFinancial` column it feeds. Every column here
# is operator-editable on the P&L; tagging bank rows with the slug
# is what turns it into a bank-fed line. Amounts are summed as
# absolutes — the column's sign is decided by which P&L bucket it
# sits in (INCOME_FIELDS / EXPENSE_FIELDS), not by the
# transaction's direction.
#
# The operator-facing LABEL is deliberately not here: it lives in
# `Monthly.Services.labels`, where the store can change it. A slug
# is an identifier and must never move; a label is decoration.
#
# `taxable_sales` / `non_taxable` are absent on purpose. They are
# renameable on the P&L form like any other line, but they must not
# be bank-taggable: the day's sales already reach the books through
# the register close, and tagging the matching bank deposit into
# them would count the same money twice.
BANK_PL_CATEGORIES: dict[str, str] = {
    # Expenses
    "pl_credit_card_fees":   "credit_card_fees",
    "pl_money_order_rent":   "money_order_rent",
    "pl_emaginenet_tech":    "emaginenet_tech",
    "pl_irs_payroll_tax":    "irs_payroll_tax",
    "pl_texas_workforce":    "texas_workforce",
    "pl_other_taxes":        "other_taxes",
    "pl_accounting_charges": "accounting_charges",
    "pl_other_expense_1":    "other_expense_1",
    "pl_other_expense_2":    "other_expense_2",
    "pl_other_expense_3":    "other_expense_3",
    "pl_other_expense_4":    "other_expense_4",
    "pl_other_expense_5":    "other_expense_5",
    # Income
    "pl_mt_commission_in_bank":  "mt_commission_in_bank",
    "pl_rebates_commissions":    "rebates_commissions",
    "pl_bill_payment_charge":    "bill_payment_charge",
    "pl_phone_recargas":         "phone_recargas",
    "pl_boost_mobile":           "boost_mobile",
    "pl_return_check_hold_fees": "return_check_hold_fees",
    "pl_other_income_1":         "other_income_1",
    "pl_other_income_2":         "other_income_2",
    "pl_other_income_3":         "other_income_3",
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
        return BANK_PL_CATEGORIES[slug]
    if is_bank_charge_family(slug):
        return BANK_CHARGES_PL_FIELD
    return None


def bank_category_label(
    slug: str | None, labels: dict[str, str] | None = None,
) -> str:
    """Operator-friendly label for a category slug.

    Lookup priority:
      1. `BANK_CATEGORIES_NON_POSTING` static dict.
      2. `BANK_PL_CATEGORIES` → "P&L · <the store's name for it>".
      3. Dynamic `bank_charge_<last4>` slug → "Bank charge —
         ••<last4>" (so the UI doesn't show the raw slug).
      4. DailyBook line-item kind → titlecase of singular label.
      5. Fall through to the slug itself.

    `labels` is a store's resolved P&L line names
    (`Monthly.Services.resolved_line_labels`). Omitting it renders
    the shipped defaults, which is what a store-less caller (a
    platform report, a log line) wants.

    Empty / None slug returns "Uncategorized".
    """
    from api.Modules.Monthly.Services.labels import line_label

    if not slug:
        return "Uncategorized"
    if slug in BANK_CATEGORIES_NON_POSTING:
        return BANK_CATEGORIES_NON_POSTING[slug]
    if slug in BANK_PL_CATEGORIES:
        return f"P&L · {line_label(labels or {}, BANK_PL_CATEGORIES[slug])}"
    # Dynamic per-account bank-charge slug — render uniformly.
    if slug.startswith("bank_charge_"):
        suffix = slug[len("bank_charge_"):]
        if suffix:
            return f"Bank charge — ••{suffix}"
    if slug in LINE_ITEM_KINDS:
        return LINE_ITEM_KINDS[slug][1].title()
    return slug


def _slugs_in_use(db: Session, store_id: int) -> set[str]:
    """Every category slug this store has already committed to —
    tagged on a transaction or named by a rule.

    The picker hides P&L slots the store has not claimed, and a
    hidden slug would be a slug the server rejects. A store that
    tagged `pl_other_expense_1` last month and later cleared the
    name would then find its own rule refused, so anything already
    in use stays offered and stays valid whatever its name is.
    """
    from api.Modules.BankSync.Models import BankRule, BankTransaction

    used = {
        str(s or "")
        for (s,) in db.query(BankTransaction.category_slug)
                      .filter(BankTransaction.store_id == store_id)
                      .distinct()
    }
    used |= {
        str(s or "")
        for (s,) in db.query(BankRule.target_kind)
                      .filter(BankRule.store_id == store_id)
                      .distinct()
    }
    used.discard("")
    return used


def _pl_options(
    db: Session, store_id: int | None,
) -> list[tuple[str, str]]:
    """The `pl_*` options for a store's picker, in P&L order and
    under the store's own names.

    A blank slot the store has not named (`other_expense_4` still
    called "Other expense 4") is left out: an unclaimed slot in a
    dropdown is a slug nobody can pick meaningfully, and the list
    is long enough without eight of them. Naming it on the P&L
    categories page is what puts it here. Slots already in use stay
    listed regardless — see `_slugs_in_use`.

    Without a `store_id` there is nobody to have claimed anything,
    so the store-less call lists every line under its shipped
    default. That is the platform's own view of the catalogue, not
    an empty store's.
    """
    from api.Modules.Monthly.Services.labels import (
        MONTHLY_LINE_DEFAULTS, NAMEABLE_SLOT_FIELDS, custom_line_labels,
        line_label,
    )

    named: dict[str, str] = {}
    in_use: set[str] = set()
    hide_unclaimed = store_id is not None
    if store_id is not None:
        named = custom_line_labels(db, store_id)
        if any(f in NAMEABLE_SLOT_FIELDS and f not in named
               for f in BANK_PL_CATEGORIES.values()):
            in_use = _slugs_in_use(db, store_id)

    # P&L order, not slug order: the picker should read like the
    # form the operator already knows.
    ordered = [
        (slug, field)
        for field in MONTHLY_LINE_DEFAULTS
        for slug, mapped in BANK_PL_CATEGORIES.items()
        if mapped == field
    ]
    out: list[tuple[str, str]] = []
    for slug, field in ordered:
        if (
            hide_unclaimed
            and field in NAMEABLE_SLOT_FIELDS
            and field not in named
            and slug not in in_use
        ):
            continue
        out.append((slug, line_label(named, field)))
    return out


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
            # The operator's nickname for the account wins — a
            # store that renamed ••0230 to "MSB checking" should
            # read "Bank charge — MSB checking" here, not a number
            # it has already decided it does not think in.
            other[slug] = f"Bank charge — {a.label}"
    return other


def bank_category_groups(
    db: Session, store_id: int | None = None,
) -> list[tuple[str, list[tuple[str, str]]]]:
    """Grouped `(group_label, [(slug, label), ...])` tuples for
    dropdowns. Three groups, in the order an operator should read
    them: what posts to today's book, what feeds the month's P&L,
    and what is only a tag.

    When `store_id` is given the list is the store's: P&L lines
    carry its own names and hide the slots it has not claimed, and
    the "Other" group gains a `bank_charge_<last4>` entry per
    connected account. This is the single definition of "a category
    this store may use" — `is_valid_bank_category` reads it rather
    than keeping a second list.
    """
    daily = [
        (slug, meta[1].title())
        for slug, meta in LINE_ITEM_KINDS.items()
    ]
    other = _other_options(db, store_id)
    return [
        ("Daily book", daily),
        ("Monthly P&L", _pl_options(db, store_id)),
        ("Other (no daily-book impact)", list(other.items())),
    ]


def is_valid_bank_category(
    db: Session, slug: str | None, store_id: int,
) -> bool:
    """True iff `slug` is an acceptable target for a manual
    bank-transaction tag or a `BankRule`.

    Defined as "something `bank_category_groups(store_id)` offers",
    so the picker and the validator cannot disagree — they did
    once, and a slug the SPA showed but the server refused is a
    422 the operator cannot act on.

    One deliberate exception, below: `bank_charge_<last4>` also
    accepts the unstripped form (`bank_charge_0210` beside
    `bank_charge_210`). The picker has only ever offered the
    stripped one, so this costs nothing today and keeps an old row
    or an operator-typed slug from being refused.
    """
    if not slug:
        return False
    if any(
        slug == offered
        for _group, options in bank_category_groups(db, store_id)
        for offered, _label in options
    ):
        return True
    return _is_alias_of_connected_bank_charge(db, slug, store_id)


def _is_alias_of_connected_bank_charge(
    db: Session, slug: str, store_id: int,
) -> bool:
    """`bank_charge_0210` for a store whose account ends 0210 — the
    same slug the picker offers as `bank_charge_210`."""
    if not slug.startswith("bank_charge_"):
        return False
    last4 = slug[len("bank_charge_"):]
    if not last4:
        return False
    from api.Modules.BankSync.Models import StripeBankAccount
    accounts = (
        db.query(StripeBankAccount)
          .filter_by(store_id=store_id)
          .all()
    )
    return any(
        a.last4 and last4 in {a.last4, a.last4.lstrip("0") or a.last4}
        for a in accounts
    )

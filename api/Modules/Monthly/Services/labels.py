"""What a store calls its P&L lines.

The monthly P&L is a fixed set of columns. That is not an accident:
the totals, the tax export, the daily-ledger roll-up and the bank
feed are all built on column names, and a column name has to mean
the same thing in January and in December. So a store cannot invent
a category in the sense of adding a line to the ledger.

What it CAN do is claim one. Five ``other_expense_*`` and three
``other_income_*`` columns ship blank for exactly this reason, and
every bank-fed P&L line is already wired end to end — editable on
the form, taggable from the bank, conditionally locked while the
bank feeds it, counted in the totals. All that is missing is a name
the operator recognises, and that is what this module owns.

Two rules keep the rename honest:

1. **The field is the identity, the label is decoration.** A rule,
   a tag, an export column and a historical month all point at
   ``other_expense_1``; renaming it to "Bank Fee" changes what the
   operator reads and nothing else. Renaming it again tomorrow does
   not orphan anything.
2. **A blank label means the shipped default.** There is no third
   state. Deleting a custom name restores "Other expense 1" rather
   than leaving the line nameless.

``NAMEABLE_SLOT_FIELDS`` is the subset that is blank-by-design. It
matters beyond cosmetics: the bank-category picker hides an
unclaimed slot (see ``BankSync.Services.categories``), because
"Other expense 4" in a dropdown is noise until somebody decides
what it is for.
"""
from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.Monthly.Models import MonthlyLineLabel


# The P&L lines a store may rename, in the order the settings page
# lists them: income first, then expenses, each ending with the
# blank slots.
#
# The rule for what is in here: **a line the operator types
# themselves**. The daily-derived lines (`cash_expenses`,
# `check_purchases`, `check_cashing_fees`, …) are deliberately out,
# because their names are not ours to change — each one is the P&L
# face of a daily-book kind, and calling it something else on this
# page would hide where the number came from. `return_check_gl` is
# out for the same reason (the return-check workflow owns it), and
# the cash-flow adjustments at the foot of the P&L (`over_short`,
# `cash_carry_forward`, …) are out because they are structural, not
# categories.
#
# field → shipped default label. This is the ONE place the default
# names live; the bank-category picker and the P&L form both read
# them from here.
MONTHLY_LINE_DEFAULTS: dict[str, str] = {
    # Income
    "taxable_sales":          "Taxable sales",
    "non_taxable":            "Non-taxable",
    "bill_payment_charge":    "Bill payment charge",
    "phone_recargas":         "Phone recargas",
    "boost_mobile":           "Boost Mobile",
    "return_check_hold_fees": "Return check hold fees",
    "rebates_commissions":    "Rebates / commissions",
    "mt_commission_in_bank":  "Money transfer commission in bank",
    "other_income_1":         "Other income 1",
    "other_income_2":         "Other income 2",
    "other_income_3":         "Other income 3",
    # Expenses
    "bank_charges_total":     "Bank charges",
    "credit_card_fees":       "Credit card fees",
    "money_order_rent":       "Money order rent",
    "emaginenet_tech":        "EmagineNet / tech",
    "irs_payroll_tax":        "IRS payroll tax",
    "texas_workforce":        "Texas workforce",
    "other_taxes":            "Other taxes",
    "accounting_charges":     "Accounting charges",
    "other_expense_1":        "Other expense 1",
    "other_expense_2":        "Other expense 2",
    "other_expense_3":        "Other expense 3",
    "other_expense_4":        "Other expense 4",
    "other_expense_5":        "Other expense 5",
}

# Which half of the P&L each line sits in. Drives the settings
# page's grouping; the income / expense arithmetic itself lives in
# `Services/monthly.py` (INCOME_FIELDS / EXPENSE_FIELDS) and is NOT
# derived from this — `test_line_labels.py` asserts the two agree.
_INCOME_LINES: frozenset[str] = frozenset({
    "taxable_sales", "non_taxable", "bill_payment_charge",
    "phone_recargas", "boost_mobile", "return_check_hold_fees",
    "rebates_commissions", "mt_commission_in_bank",
    "other_income_1", "other_income_2", "other_income_3",
})

MONTHLY_LINE_SECTIONS: dict[str, str] = {
    field: ("Income" if field in _INCOME_LINES else "Expenses")
    for field in MONTHLY_LINE_DEFAULTS
}

# The blank-by-design slots — a store names these to get a category
# we did not ship. Their defaults ("Other expense 1") are
# placeholders, not names, which is why an unnamed slot is hidden
# from the bank-category picker.
NAMEABLE_SLOT_FIELDS: frozenset[str] = frozenset({
    "other_income_1", "other_income_2", "other_income_3",
    "other_expense_1", "other_expense_2", "other_expense_3",
    "other_expense_4", "other_expense_5",
})

RENAMEABLE_MONTHLY_FIELDS: tuple[str, ...] = tuple(MONTHLY_LINE_DEFAULTS)

# Longest label we store. Long enough for "Money transfer
# commission in bank" (the longest default) with room to spare,
# short enough to fit a dropdown option and a form label.
MAX_LABEL_LEN = 60


def custom_line_labels(db: Session, store_id: int) -> dict[str, str]:
    """The store's OWN names only — ``{field: label}`` for the
    lines it has renamed. Fields it never touched are absent, and a
    row whose label was cleared is treated as absent.

    Callers that need a name for every line want
    ``resolved_line_labels``; this one answers "which lines has
    this store claimed?", which is what the picker needs to decide
    whether a blank slot is in use yet.
    """
    rows = (
        db.query(MonthlyLineLabel)
          .filter(MonthlyLineLabel.store_id == store_id)
          .all()
    )
    return {
        str(r.field): str(r.label).strip()
        for r in rows
        if str(r.field) in MONTHLY_LINE_DEFAULTS and str(r.label or "").strip()
    }


def resolved_line_labels(db: Session, store_id: int) -> dict[str, str]:
    """``{field: label}`` for EVERY renameable line, the store's
    name where it set one and the shipped default everywhere else.
    This is what the P&L form and the category picker render.
    """
    resolved = dict(MONTHLY_LINE_DEFAULTS)
    resolved.update(custom_line_labels(db, store_id))
    return resolved


def line_label(labels: dict[str, str], field: str) -> str:
    """One line's label out of a map from either function above,
    falling back to the shipped default and then to the raw field
    name. Pure — pass the map in rather than querying per line."""
    return labels.get(field) or MONTHLY_LINE_DEFAULTS.get(field, field)


class UnknownMonthlyLineError(ValueError):
    """Raised when a caller tries to rename a column that is not
    renameable — a daily-derived line, a computed total, or a
    typo. The endpoint turns this into a 422 rather than silently
    dropping the field, so a stale SPA cannot quietly fail to save.
    """

    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(f"'{field}' is not a renameable P&L line")


def set_line_labels(
    db: Session, store_id: int, labels: dict[str, str],
) -> dict[str, str]:
    """Write the store's names for the given lines and return the
    full resolved map.

    ``labels`` is a partial update: only the fields present are
    touched. An empty / whitespace value is a RESET — the row is
    deleted and the line goes back to its shipped default, so there
    is no way to end up with a blank name on the form.

    Does not commit; the caller owns the transaction (so the audit
    row lands in the same one).
    """
    for field in labels:
        if field not in MONTHLY_LINE_DEFAULTS:
            raise UnknownMonthlyLineError(field)

    existing = {
        str(r.field): r
        for r in db.query(MonthlyLineLabel)
                   .filter(MonthlyLineLabel.store_id == store_id)
                   .all()
    }
    for field, raw in labels.items():
        value = (raw or "").strip()[:MAX_LABEL_LEN]
        row = existing.get(field)
        if not value:
            if row is not None:
                db.delete(row)
            continue
        if row is None:
            db.add(MonthlyLineLabel(
                store_id=store_id, field=field, label=value,
            ))
        else:
            row.label = value
            row.updated_at = utc_now()
    db.flush()
    return resolved_line_labels(db, store_id)

"""The store's own names for its P&L lines.

The contract these protect: renaming a line changes a LABEL and
nothing else. No column moves, no historical month is rewritten, no
bank rule is orphaned — and a blank name always falls back to the
one we ship rather than leaving a line nameless.
"""
import pytest
from fastapi.testclient import TestClient

from tests._app import db, db_session


def _auth(client_, store_id):
    from tests.conftest import login_admin
    return {"Authorization": f"Bearer {login_admin(client_, store_id)}"}


# ── the tables agree with the rest of the P&L ───────────────


def test_every_renameable_line_is_a_real_monthly_column():
    """A label pointing at a column that does not exist would show
    an input nobody's edits reach."""
    from api.Modules.Monthly.Models import MonthlyFinancial
    from api.Modules.Monthly.Services import RENAMEABLE_MONTHLY_FIELDS
    for field in RENAMEABLE_MONTHLY_FIELDS:
        assert hasattr(MonthlyFinancial, field), field


def test_every_renameable_line_is_operator_editable():
    """Renaming a daily-derived line would hide where its number
    comes from, so the renameable set stays inside the set the
    operator types themselves.

    `bank_charges_total` is the one line outside
    EDITABLE_MONTHLY_FIELDS that still belongs here: the operator
    types it whenever the bank is not feeding it, through
    `update_monthly`'s own conditional branch rather than the
    generic loop (Monthly/INVARIANTS.md → Category 3).
    """
    from api.Modules.Monthly.Services import (
        EDITABLE_MONTHLY_FIELDS, RENAMEABLE_MONTHLY_FIELDS,
    )
    operator_typed = set(EDITABLE_MONTHLY_FIELDS) | {"bank_charges_total"}
    assert set(RENAMEABLE_MONTHLY_FIELDS) <= operator_typed


def test_sections_match_the_pl_arithmetic():
    """The settings page groups lines into Income / Expenses; that
    grouping has to be the one the totals actually use, or the page
    lies about which way a line moves the net."""
    from api.Modules.Monthly.Services.monthly import (
        EXPENSE_FIELDS, INCOME_FIELDS,
    )
    from api.Modules.Monthly.Services import MONTHLY_LINE_SECTIONS
    for field, section in MONTHLY_LINE_SECTIONS.items():
        expected = "Income" if field in INCOME_FIELDS else "Expenses"
        assert section == expected, field
        assert field in (INCOME_FIELDS + EXPENSE_FIELDS), field


def test_every_slot_is_renameable():
    from api.Modules.Monthly.Services import (
        NAMEABLE_SLOT_FIELDS, RENAMEABLE_MONTHLY_FIELDS,
    )
    assert NAMEABLE_SLOT_FIELDS <= set(RENAMEABLE_MONTHLY_FIELDS)


def test_every_bank_pl_slug_targets_a_renameable_line():
    """The picker renders a `pl_*` slug under the store's name for
    its column — a slug whose column is not renameable would be
    stuck on the shipped default forever."""
    from api.Modules.BankSync.Services import BANK_PL_CATEGORIES
    from api.Modules.Monthly.Services import RENAMEABLE_MONTHLY_FIELDS
    for slug, field in BANK_PL_CATEGORIES.items():
        assert field in RENAMEABLE_MONTHLY_FIELDS, slug


def test_sales_lines_are_renameable_but_not_bank_taggable():
    """Sales reach the books through the register close. A bank
    category pointing at them would count the deposit as revenue a
    second time."""
    from api.Modules.BankSync.Services import BANK_PL_CATEGORIES
    from api.Modules.Monthly.Services import RENAMEABLE_MONTHLY_FIELDS
    for field in ("taxable_sales", "non_taxable"):
        assert field in RENAMEABLE_MONTHLY_FIELDS
        assert field not in BANK_PL_CATEGORIES.values()


# ── the service ─────────────────────────────────────────────


def test_resolved_labels_start_at_the_shipped_defaults(test_store_id):
    from api.Modules.Monthly.Services import (
        MONTHLY_LINE_DEFAULTS, resolved_line_labels,
    )
    with db_session():
        assert resolved_line_labels(db.session, test_store_id) == \
            MONTHLY_LINE_DEFAULTS


def test_setting_a_label_only_changes_that_line(test_store_id):
    from api.Modules.Monthly.Services import (
        MONTHLY_LINE_DEFAULTS, custom_line_labels, resolved_line_labels,
        set_line_labels,
    )
    with db_session():
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "Bank Fee"})
        db.session.commit()
        assert custom_line_labels(db.session, test_store_id) == \
            {"other_expense_1": "Bank Fee"}
        resolved = resolved_line_labels(db.session, test_store_id)
        assert resolved["other_expense_1"] == "Bank Fee"
        assert resolved["other_expense_2"] == \
            MONTHLY_LINE_DEFAULTS["other_expense_2"]


def test_blank_label_resets_to_the_shipped_default(test_store_id):
    from api.Modules.Monthly.Services import (
        MONTHLY_LINE_DEFAULTS, custom_line_labels, resolved_line_labels,
        set_line_labels,
    )
    with db_session():
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "Bank Fee"})
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "   "})
        db.session.commit()
        assert custom_line_labels(db.session, test_store_id) == {}
        assert resolved_line_labels(db.session, test_store_id)["other_expense_1"] \
            == MONTHLY_LINE_DEFAULTS["other_expense_1"]


def test_renaming_never_touches_a_saved_month(test_store_id):
    """The point of the whole feature: the money stays where it
    is. A month saved under the old name reads back identically."""
    from api.Modules.Monthly.Models import MonthlyFinancial
    from api.Modules.Monthly.Services import set_line_labels
    with db_session():
        row = MonthlyFinancial(
            store_id=test_store_id, year=2026, month=4,
            other_expense_1=125.50,
        )
        db.session.add(row); db.session.commit()
        rid = row.id
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "Bank Fee"})
        db.session.commit()
        again = db.session.get(MonthlyFinancial, rid)
        assert again.other_expense_1 == 125.50


def test_unknown_field_is_refused(test_store_id):
    from api.Modules.Monthly.Services import (
        UnknownMonthlyLineError, set_line_labels,
    )
    with db_session():
        with pytest.raises(UnknownMonthlyLineError):
            set_line_labels(db.session, test_store_id,
                            {"cash_expenses": "Nope"})


def test_a_label_is_truncated_not_rejected(test_store_id):
    from api.Modules.Monthly.Services import (
        MAX_LABEL_LEN, custom_line_labels, set_line_labels,
    )
    with db_session():
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "x" * 200})
        db.session.commit()
        stored = custom_line_labels(db.session, test_store_id)["other_expense_1"]
        assert len(stored) == MAX_LABEL_LEN


def test_labels_are_per_store(test_store_id):
    from api.Modules.Monthly.Services import (
        MONTHLY_LINE_DEFAULTS, resolved_line_labels, set_line_labels,
    )
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="other", slug="other-lbl",
                      plan="basic", email="o@example.com")
        db.session.add(other); db.session.flush()
        set_line_labels(db.session, test_store_id,
                        {"other_expense_1": "Bank Fee"})
        db.session.commit()
        assert resolved_line_labels(db.session, other.id)["other_expense_1"] \
            == MONTHLY_LINE_DEFAULTS["other_expense_1"]


# ── the endpoints ───────────────────────────────────────────


def test_labels_endpoint_lists_every_renameable_line(client, test_store_id):
    from api.Modules.Monthly.Services import RENAMEABLE_MONTHLY_FIELDS
    resp = client.get("/api/v2/monthly/labels",
                      headers=_auth(client, test_store_id))
    assert resp.status_code == 200
    lines = resp.get_json()["lines"]
    assert [l["field"] for l in lines] == list(RENAMEABLE_MONTHLY_FIELDS)
    slot = next(l for l in lines if l["field"] == "other_expense_1")
    assert slot["is_slot"] is True
    assert slot["is_custom"] is False
    assert slot["bank_taggable"] is True
    sales = next(l for l in lines if l["field"] == "taxable_sales")
    assert sales["bank_taggable"] is False


def test_put_labels_saves_and_echoes(client, test_store_id):
    headers = _auth(client, test_store_id)
    resp = client.put(
        "/api/v2/monthly/labels",
        json={"labels": {"other_expense_1": "Bank Fee"}},
        headers=headers,
    )
    assert resp.status_code == 200
    row = next(l for l in resp.get_json()["lines"]
               if l["field"] == "other_expense_1")
    assert row["label"] == "Bank Fee"
    assert row["is_custom"] is True
    assert row["default_label"] == "Other expense 1"


def test_put_labels_rejects_a_non_renameable_column(client, test_store_id):
    resp = client.put(
        "/api/v2/monthly/labels",
        json={"labels": {"cash_expenses": "Nope"}},
        headers=_auth(client, test_store_id),
    )
    assert resp.status_code == 422


def test_put_labels_writes_an_audit_row(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    client.put(
        "/api/v2/monthly/labels",
        json={"labels": {"other_expense_1": "Bank Fee"}},
        headers=_auth(client, test_store_id),
    )
    with db_session():
        row = (
            db.session.query(OperatorAuditLog)
            .filter_by(action="monthly_labels_update")
            .first()
        )
        assert row is not None
        assert "Bank Fee" in (row.target_label or "")


def test_month_payload_carries_the_store_names(client, test_store_id):
    from api.Modules.Monthly.Models import MonthlyFinancial
    headers = _auth(client, test_store_id)
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=test_store_id, year=2026, month=5,
        ))
        db.session.commit()
    client.put(
        "/api/v2/monthly/labels",
        json={"labels": {"other_expense_1": "Bank Fee"}},
        headers=headers,
    )
    resp = client.get("/api/v2/monthly/2026/5", headers=headers)
    assert resp.status_code == 200
    assert resp.get_json()["labels"]["other_expense_1"] == "Bank Fee"

"""Bank rule templates (BankSync INVARIANTS.md "Rule templates").

The owner's ask (2026-10-21): the superadmin writes rules once —
"Intermex commission deposit" or any other transaction type — and
every store sees them listed on its rules page to use. Pinned here:

* only the superadmin writes templates, every write is audited (the
  platform route contracts in tests/Modules/Superadmin cover the
  gate, the typed body and the audit marker for every route too);
* a template targets only a category every store has;
* a store lists the enabled templates under its own line names, and
  using one is an ordinary rule create;
* editing or deleting a template never touches a store's rules;
* the migration spells out the model's columns and imports no
  application code.
"""
import importlib.util
from pathlib import Path

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin, make_employee_client

BASE = "/api/v2/superadmin/bank-rule-templates"
STORE = "/api/v2/bank/rule-templates"

COMMISSION = {
    "name": "Intermex commission deposit",
    "desc_match_type": "contains",
    "desc_match_value": "INTERMEX COMM",
    "sign_filter": "credit",
    "target_kind": "pl_mt_commission_in_bank",
    "auto_post": False,
}


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def sa(client):
    from api.Modules.BankSync.Models import BankRuleTemplate
    with db_session():
        db.session.query(BankRuleTemplate).delete()
        db.session.commit()
    return _h(login_superadmin(client))


def _create(client, sa, **over):
    resp = client.post(BASE, json={**COMMISSION, **over}, headers=sa)
    assert resp.status_code == 201, resp.get_data(as_text=True)
    return resp.get_json()["template"]


def _audit_actions():
    from api.Modules.Audit.Models import SuperadminAuditLog
    with db_session():
        return [
            (a.action, a.target_type)
            for a in db.session.query(SuperadminAuditLog)
                .order_by(SuperadminAuditLog.id).all()
        ]


# ── superadmin writes ────────────────────────────────────────


def test_superadmin_creates_lists_updates_and_deletes_with_audit(client, sa):
    t = _create(client, sa)
    assert t["name"] == "Intermex commission deposit"
    assert t["target_label"] == "Money transfer commission in bank"
    assert t["enabled"] is True

    rows = client.get(BASE, headers=sa).get_json()["rows"]
    assert [r["id"] for r in rows] == [t["id"]]

    resp = client.put(f"{BASE}/{t['id']}", json={**COMMISSION, "name": "Intermex commission",
                                                  "enabled": False}, headers=sa)
    assert resp.status_code == 200
    assert resp.get_json()["template"]["name"] == "Intermex commission"
    assert resp.get_json()["template"]["enabled"] is False

    assert client.delete(f"{BASE}/{t['id']}", headers=sa).status_code == 204
    assert client.get(BASE, headers=sa).get_json()["rows"] == []

    actions = _audit_actions()
    for a in ("create_bank_rule_template", "update_bank_rule_template",
              "delete_bank_rule_template"):
        assert (a, "bank_rule_template") in actions


def test_unknown_template_is_404(client, sa):
    assert client.put(f"{BASE}/999999", json=COMMISSION, headers=sa).status_code == 404
    assert client.delete(f"{BASE}/999999", headers=sa).status_code == 404


def test_store_admin_cannot_read_or_write_the_superadmin_list(client, test_store_id, sa):
    admin = _h(login_admin(client, test_store_id))
    assert client.get(BASE, headers=admin).status_code == 403
    assert client.get(f"{BASE}/categories", headers=admin).status_code == 403
    assert client.post(BASE, json=COMMISSION, headers=admin).status_code == 403


@pytest.mark.parametrize("over, field", [
    ({"target_kind": "pl_other_expense_1"}, "target_kind"),   # a store's own slot
    ({"target_kind": "bank_charge_210"}, "target_kind"),      # one store's account
    ({"target_kind": "nope"}, "target_kind"),
    ({"name": "   "}, "name"),
    ({"desc_match_type": "", "desc_match_value": "", "sign_filter": ""}, "desc_match_value"),
    ({"desc_match_value": "  "}, "desc_match_value"),
    ({"amount_min_cents": 500, "amount_max_cents": 100}, "amount_max_cents"),
])
def test_bad_templates_are_refused_with_the_field(client, sa, over, field):
    resp = client.post(BASE, json={**COMMISSION, **over}, headers=sa)
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == field
    assert client.get(BASE, headers=sa).get_json()["rows"] == []


def test_template_categories_are_the_ones_every_store_has(client, sa):
    groups = client.get(f"{BASE}/categories", headers=sa).get_json()["groups"]
    slugs = {o["slug"] for g in groups for o in g["options"]}
    assert "pl_mt_commission_in_bank" in slugs
    assert "pl_other_taxes" in slugs          # a shipped line, not a slot
    assert "internal_transfer" in slugs
    assert any(g["posts_to_daily"] and g["options"] for g in groups)
    for slot in ("pl_other_income_1", "pl_other_expense_1", "pl_other_expense_5"):
        assert slot not in slugs
    assert not any(s.startswith("bank_charge") for s in slugs)


# ── the store's view ─────────────────────────────────────────


def test_store_lists_enabled_templates_under_its_own_names(client, test_store_id, sa):
    from api.Modules.Monthly.Models import MonthlyLineLabel
    _create(client, sa)
    _create(client, sa, name="Hidden one", enabled=False)
    with db_session():
        db.session.add(MonthlyLineLabel(
            store_id=test_store_id, field="mt_commission_in_bank",
            label="Remittance commissions",
        ))
        db.session.commit()
    admin = _h(login_admin(client, test_store_id))
    rows = client.get(STORE, headers=admin).get_json()["rows"]
    assert [r["name"] for r in rows] == ["Intermex commission deposit"]
    assert rows[0]["target_label"] == "Remittance commissions"


def test_employee_without_bank_rights_cannot_list_templates(test_store_id, sa):
    c, jwt = make_employee_client(test_store_id, username_suffix="tplemp")
    assert c.get(STORE, headers=_h(jwt)).status_code == 403


def test_using_a_template_is_an_ordinary_rule_and_outlives_it(client, test_store_id, sa):
    """The SPA's "Use" opens the rule form prefilled from the
    template; saving is POST /bank/rules. The rule is the store's own
    row: editing or deleting the template leaves it as it was."""
    from api.Modules.BankSync.Models import BankRule
    t = _create(client, sa)
    admin = _h(login_admin(client, test_store_id))
    tpl = client.get(STORE, headers=admin).get_json()["rows"][0]
    body = {k: tpl[k] for k in (
        "desc_match_type", "desc_match_value", "sign_filter",
        "amount_min_cents", "amount_max_cents", "target_kind",
        "auto_post", "post_date_offset_days",
    )}
    resp = client.post("/api/v2/bank/rules",
                       json={**body, "description": tpl["name"]}, headers=admin)
    assert resp.status_code == 201, resp.get_data(as_text=True)
    rule_id = resp.get_json()["rule"]["id"]

    client.put(f"{BASE}/{t['id']}", json={**COMMISSION, "desc_match_value": "CHANGED"},
               headers=sa)
    client.delete(f"{BASE}/{t['id']}", headers=sa)
    with db_session():
        r = db.session.get(BankRule, rule_id)
        assert r is not None
        assert r.desc_match_value == "INTERMEX COMM"
        assert r.store_id == test_store_id


def test_superadmin_has_no_store_list(client, sa):
    assert client.get(STORE, headers=sa).status_code in (400, 403)


# ── migration ────────────────────────────────────────────────

_MIGRATION = (
    Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "f2a7c4e9b1d6_bank_rule_template.py"
)


def test_migration_creates_exactly_the_model_columns():
    import sqlalchemy as sa_
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from api.Modules.BankSync.Models import BankRuleTemplate

    spec = importlib.util.spec_from_file_location("brt_migration", _MIGRATION)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    engine = sa_.create_engine("sqlite://")
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE tenancy_user (id INTEGER PRIMARY KEY)")
        ctx = MigrationContext.configure(conn)
        module.op = Operations(ctx)
        module.upgrade()
        module.upgrade()  # idempotent
        cols = {c["name"] for c in sa_.inspect(conn).get_columns("bank_rule_template")}
        assert cols == {c.name for c in BankRuleTemplate.__table__.columns}
        module.downgrade()
        assert "bank_rule_template" not in sa_.inspect(conn).get_table_names()


def test_migration_does_not_import_application_code():
    for line in _MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped

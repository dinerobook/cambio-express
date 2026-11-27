"""The dashboard's Monthly P&L tile (`pl_month`, owner 2026-11-27).

Store Admins only: the figures leave the server for an Admin who can
read the Monthly P&L and for nobody else. Not an employee (even one
granted the P&L), not an Admin whose access takes the P&L away, not
an owner or an accountant (they have no store dashboard at all). The
numbers are `summarize_monthly`'s, so the tile and /monthly agree, and
`to_reconcile` is the Bank page's own To reconcile count.
"""
from datetime import datetime

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee


SUMMARY = "/api/v2/dashboard/summary"


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _mk_user(store_id, username, role, password="emppass1234"):
    from api.Modules.Tenancy.Models import User
    with db_session():
        u = User(store_id=store_id, username=username, role=role,
                 is_active=True, full_name=username)
        u.set_password(password)
        db.session.add(u)
        db.session.commit()
        return u.id


def _seed_month(store_id, year, month):
    from api.Modules.Monthly.Models import MonthlyFinancial
    with db_session():
        db.session.add(MonthlyFinancial(
            store_id=store_id, year=year, month=month,
            taxable_sales=1000.0, bank_charges_total=100.0,
            over_short=50.0, profit_distributed=200.0,
        ))
        db.session.commit()


def _seed_bank_rows(store_id, *, untagged=2, tagged=1):
    from api.Modules.BankSync.Models import BankTransaction, StripeBankAccount
    with db_session():
        a = StripeBankAccount(
            store_id=store_id, stripe_account_id="fcacc_tile",
            institution_name="Bank", last4="0230", enabled=True,
        )
        db.session.add(a)
        db.session.commit()
        n = 0
        for slug in [""] * untagged + ["pl_credit_card_fees"] * tagged:
            n += 1
            db.session.add(BankTransaction(
                store_id=store_id, stripe_bank_account_id=a.id,
                stripe_transaction_id=f"txn_tile_{n}", amount_cents=-500,
                description="X", category_slug=slug,
                posted_at=datetime(2026, 11, 20, 10), status="posted",
            ))
        db.session.commit()


def _bank_sync(store_id, on):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=store_id, flag_key="bank_sync", enabled=on,
        ))
        db.session.commit()


# ── grant ────────────────────────────────────────────────────


def test_admin_gets_the_tile_with_the_monthly_pl_figures(client, test_store_id):
    from api.Core.Clock import local_today
    today = local_today("")
    _seed_month(test_store_id, today.year, today.month)
    h = _h(login_admin(client, test_store_id))
    report = client.get(
        f"/api/v2/monthly/{today.year}/{today.month}", headers=h,
    ).get_json()["report"]
    tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
    assert tile["year"] == today.year and tile["month"] == today.month
    assert tile["total_income"] == report["total_income"] == 1050.0
    assert tile["total_expenses"] == report["total_expenses"] == 300.0
    assert tile["net_profit"] == report["net_profit"] == 750.0
    assert tile["days_entered"] == report["days_entered"]


def test_admin_tile_reads_zero_before_anything_is_entered(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
    assert tile["total_income"] == 0.0
    assert tile["total_expenses"] == 0.0
    assert tile["net_profit"] == 0.0
    assert tile["days_entered"] == 0


def test_to_reconcile_is_the_bank_pages_count(client, test_store_id):
    _seed_bank_rows(test_store_id, untagged=2, tagged=1)
    h = _h(login_admin(client, test_store_id))
    tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
    assert tile["to_reconcile"] == 2
    page = client.get(
        "/api/v2/bank/transactions?tab=to_reconcile", headers=h,
    ).get_json()
    assert page["to_reconcile_count"] == 2


# ── deny ─────────────────────────────────────────────────────


def test_to_reconcile_is_null_when_the_store_has_no_bank_sync(
    client, test_store_id,
):
    _seed_bank_rows(test_store_id)
    _bank_sync(test_store_id, False)
    h = _h(login_admin(client, test_store_id))
    tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
    assert tile is not None
    assert tile["to_reconcile"] is None


def test_to_reconcile_is_null_for_an_admin_who_cannot_tag_bank_rows(
    client, test_store_id,
):
    from api.Core.Permissions import clear_user_permissions, set_user_permissions
    _seed_bank_rows(test_store_id)
    uid = _mk_user(test_store_id, "tile_admin_nobank", "admin")
    set_user_permissions(test_store_id, uid, {"monthly": {"read": True}})
    try:
        h = _h(login_employee(client, test_store_id, "tile_admin_nobank",
                              password="emppass1234"))
        tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
        assert tile is not None
        assert tile["to_reconcile"] is None
    finally:
        clear_user_permissions(test_store_id, uid)


def test_admin_whose_access_removes_the_pl_gets_no_tile(client, test_store_id):
    from api.Core.Permissions import clear_user_permissions, set_user_permissions
    uid = _mk_user(test_store_id, "tile_admin_nopl", "admin")
    set_user_permissions(test_store_id, uid, {"users": {"read": True}})
    try:
        h = _h(login_employee(client, test_store_id, "tile_admin_nopl",
                              password="emppass1234"))
        summary = client.get(SUMMARY, headers=h).get_json()
        assert summary["role"] == "admin"
        assert summary["pl_month"] is None
    finally:
        clear_user_permissions(test_store_id, uid)


def test_revoking_the_pl_takes_the_tile_away_live(client, test_store_id):
    """Revoke: the same signed-in Admin loses the tile on the next
    load once the P&L is taken off their access."""
    from api.Core.Permissions import clear_user_permissions, set_user_permissions
    uid = _mk_user(test_store_id, "tile_admin_revoke", "admin")
    h = _h(login_employee(client, test_store_id, "tile_admin_revoke",
                          password="emppass1234"))
    try:
        assert client.get(SUMMARY, headers=h).get_json()["pl_month"] is not None
        set_user_permissions(test_store_id, uid, {"users": {"read": True}})
        resp = client.get(SUMMARY, headers=h)
        if resp.status_code == 200:
            assert resp.get_json()["pl_month"] is None
        else:
            # A permission change may end the session; either way no
            # figure reaches the old token.
            assert resp.status_code == 401
    finally:
        clear_user_permissions(test_store_id, uid)


def test_employee_never_gets_the_tile_even_with_the_pl_granted(
    client, test_store_id,
):
    from api.Core.Permissions import clear_user_permissions, set_user_permissions
    from api.Core.Clock import local_today
    today = local_today("")
    _seed_month(test_store_id, today.year, today.month)
    uid = _mk_user(test_store_id, "tile_emp_pl", "employee")
    set_user_permissions(test_store_id, uid, {
        "monthly": {"read": True}, "reports": {"read": True},
        "bank_sync": {"read": True, "update": True},
    })
    try:
        h = _h(login_employee(client, test_store_id, "tile_emp_pl",
                              password="emppass1234"))
        summary = client.get(SUMMARY, headers=h).get_json()
        assert summary["role"] == "employee"
        assert "pl_month" not in summary
        assert "net_profit" not in str(summary)
    finally:
        clear_user_permissions(test_store_id, uid)


def test_accountant_gets_no_store_dashboard(client, test_store_id):
    _mk_user(test_store_id, "tile_acct", "accountant", password="acctpass1234")
    h = _h(login_employee(client, test_store_id, "tile_acct",
                          password="acctpass1234"))
    resp = client.get(SUMMARY, headers=h)
    assert resp.status_code in (403, 404)
    assert "pl_month" not in resp.get_data(as_text=True)


def test_owner_gets_no_store_dashboard(client):
    from api.Modules.Tenancy.Models import User
    from tests.conftest import login_owner
    with db_session():
        u = User(username="tile-owner", full_name="Owner",
                 role="owner", store_id=None)
        u.set_password("ownerpass123")
        db.session.add(u)
        db.session.commit()
    resp = client.get(SUMMARY, headers=_h(login_owner(client, "tile-owner")))
    assert resp.status_code in (400, 403)
    assert "pl_month" not in resp.get_data(as_text=True)


def test_store_scope_the_tile_counts_only_this_stores_bank_rows(
    client, test_store_id,
):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other tile store", slug="other-tile-store", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _seed_bank_rows(other_id, untagged=3, tagged=0)
    h = _h(login_admin(client, test_store_id))
    tile = client.get(SUMMARY, headers=h).get_json()["pl_month"]
    assert tile["to_reconcile"] == 0

"""A store's own P&L categories (owner 2026-11-27: unlimited) —
Services/custom_categories.py, Monthly INVARIANTS "Store categories".

* add / rename / archive / restore, audited, names unique per store;
* offered in the bank picker and taggable only with the switch on;
* a tagged row counts in the category's half, in the month of its
  booking day, in the statement, the Transactions tab and the tax pack;
* archived: off the picker, rows keep counting;
* access (read vs update), switch, store scope.
"""
import csv
import io
import zipfile
from datetime import date, datetime

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client
from tests.Modules.Monthly.test_transactions_ledger import (
    M, Y, _account, _bank, _flags, _h, _msb_day,
)

CATS = "/api/v2/monthly/categories/custom"


def _admin(client, sid):
    return _h(login_admin(client, sid))


def _add(client, sid, name, section="expense"):
    return client.post(CATS, json={"name": name, "section": section},
                       headers=_admin(client, sid))


def _categorize(client, sid, txn, slug):
    return client.post(
        f"/api/v2/bank/transactions/{txn}/categorize",
        json={"target_kind": slug}, headers=_admin(client, sid),
    )


def _month(client, sid, month=M):
    return client.get(
        f"/api/v2/monthly/{Y}/{month}", headers=_admin(client, sid),
    ).get_json()


def _picker(client, sid):
    groups = client.get(
        "/api/v2/bank/categories", headers=_admin(client, sid),
    ).get_json()["groups"]
    return {o["slug"]: o["label"] for g in groups for o in g["options"]}


def test_off_the_store_has_none(client, test_store_id):
    sid = test_store_id
    body = client.get(CATS, headers=_admin(client, sid)).get_json()
    assert body == {"enabled": False, "rows": []}
    assert _add(client, sid, "Ice").status_code == 403


def test_add_rename_archive_restore(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    sid = test_store_id
    _flags(sid)
    resp = _add(client, sid, "  Ice   delivery ")
    assert resp.status_code == 201, resp.text
    cat = resp.get_json()["category"]
    assert cat["name"] == "Ice delivery" and cat["section"] == "expense"
    assert cat["slug"] == f"plc_{cat['id']}" and cat["in_use"] == 0
    assert _add(client, sid, "ICE DELIVERY").status_code == 422
    assert _add(client, sid, "").status_code == 422
    assert _add(client, sid, "x" * 61).status_code == 422
    h = _admin(client, sid)
    resp = client.put(f"{CATS}/{cat['id']}", json={"name": "Ice"}, headers=h)
    assert resp.get_json()["category"]["name"] == "Ice"
    resp = client.post(f"{CATS}/{cat['id']}/archive", headers=h)
    assert resp.get_json()["category"]["archived"] is True
    # The name is free again while archived; restoring then clashes.
    assert _add(client, sid, "Ice").status_code == 201
    assert client.post(f"{CATS}/{cat['id']}/restore", headers=h).status_code == 422
    with db_session():
        actions = {a.action for a in db.session.query(OperatorAuditLog).filter(
            OperatorAuditLog.target_type == "monthly_pl_category",
        )}
    assert {"monthly_category_create", "monthly_category_rename",
            "monthly_category_archive"} <= actions


def test_a_tagged_row_counts_in_its_half(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    ice = _add(client, sid, "Ice").get_json()["category"]
    lotto = _add(client, sid, "Lottery commission", "income").get_json()["category"]
    assert _picker(client, sid)[ice["slug"]] == "Ice"
    a = _bank(sid, acct, -2500, datetime(Y, M, 5), desc="ICE CO")
    b = _bank(sid, acct, 12000, datetime(Y, M, 6), desc="LOTTERY")
    # Posted Dec 1, booked Nov 30: November's.
    c = _bank(sid, acct, -500, datetime(Y, 12, 1), desc="ICE CO 2",
              override=date(Y, 11, 30))
    _msb_day(sid, date(Y, M, 1), taxable_sales=100.0)
    for txn, slug in ((a, ice["slug"]), (b, lotto["slug"]), (c, ice["slug"])):
        assert _categorize(client, sid, txn, slug).status_code == 200
    r = _month(client, sid)["report"]
    lines = {x["name"]: x for x in r["custom_lines"]}
    assert lines["Ice"]["amount"] == 30.0 and lines["Ice"]["section"] == "expense"
    assert lines["Lottery commission"]["amount"] == 120.0
    assert r["total_income"] == 220.0
    assert r["total_expenses"] == 30.0
    assert r["net_profit"] == 190.0
    assert _month(client, sid)["labels"][ice["slug"]] == "Ice"
    # The tab: the rows count on the category, adding up to it.
    rows = client.get(
        f"/api/v2/monthly/{Y}/{M}/transactions",
        query_string={"line": ice["slug"]}, headers=_admin(client, sid),
    ).get_json()["rows"]
    assert sum(x["amount"] for x in rows if x["counted"]) == 30.0
    assert {x["bucket"] for x in rows} == {"expense"}
    # Archived: off the picker unless rows are on it, rows keep counting.
    client.post(f"{CATS}/{ice['id']}/archive", headers=_admin(client, sid))
    assert _picker(client, sid)[ice["slug"]] == "Ice (archived)"
    assert _month(client, sid)["report"]["total_expenses"] == 30.0
    listed = client.get(CATS, headers=_admin(client, sid)).get_json()["rows"]
    assert {x["name"]: x["in_use"] for x in listed} == {
        "Ice": 2, "Lottery commission": 1,
    }


def test_a_month_with_only_a_store_category_still_reads(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    ice = _add(client, sid, "Ice").get_json()["category"]
    txn = _bank(sid, acct, -2500, datetime(Y, M, 5))
    _categorize(client, sid, txn, ice["slug"])
    assert _month(client, sid)["report"]["total_expenses"] == 25.0


def test_switch_off_hides_and_stops_counting(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    ice = _add(client, sid, "Ice").get_json()["category"]
    txn = _bank(sid, acct, -2500, datetime(Y, M, 5))
    _categorize(client, sid, txn, ice["slug"])
    _msb_day(sid, date(Y, M, 1), taxable_sales=100.0)
    _flags(sid, pl=False)
    r = _month(client, sid)["report"]
    assert r["custom_lines"] == [] and r["total_expenses"] == 0.0
    assert ice["slug"] not in _picker(client, sid)
    other = _bank(sid, acct, -100, datetime(Y, M, 6))
    assert _categorize(client, sid, other, ice["slug"]).status_code == 422


def test_an_unarchived_unused_category_is_not_counted_until_tagged(
    client, test_store_id,
):
    sid = test_store_id
    _flags(sid)
    _add(client, sid, "Ice")
    _msb_day(sid, date(Y, M, 1), taxable_sales=100.0)
    assert _month(client, sid)["report"]["custom_lines"] == []


def test_the_tax_pack_carries_the_stores_categories(client, test_store_id):
    sid = test_store_id
    _flags(sid)
    acct = _account(sid)
    ice = _add(client, sid, "Ice").get_json()["category"]
    txn = _bank(sid, acct, -2500, datetime(Y, M, 5))
    _categorize(client, sid, txn, ice["slug"])
    from api.Modules.Admin.Services.tax_pack import _monthly_pl_csv
    with db_session():
        text = _monthly_pl_csv(db.session, sid, Y)
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    assert "Ice" in head
    assert head.index("Ice") > head.index("Total Income")
    nov = rows[M]
    assert nov[head.index("Ice")] == "25.00"
    assert nov[head.index("Total Expenses")] == "25.00"


def test_reading_needs_monthly_read_and_changing_needs_update(test_store_id):
    sid = test_store_id
    _flags(sid)
    c, jwt = make_employee_client(sid, username_suffix="catread", permissions={
        "monthly": {"read": True, "update": False},
    })
    assert c.get(CATS, headers=_h(jwt)).status_code == 200
    assert c.post(CATS, json={"name": "Ice", "section": "expense"},
                  headers=_h(jwt)).status_code == 403
    c, jwt = make_employee_client(sid, username_suffix="catnone", permissions={
        "monthly": {"read": False},
    })
    assert c.get(CATS, headers=_h(jwt)).status_code == 403


def test_another_stores_category_is_out_of_reach(client, test_store_id):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other cats", slug="other-cats", plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
    _flags(test_store_id)
    _flags(other_id)
    from api.Modules.Monthly.Services.custom_categories import create_category
    with db_session():
        theirs = create_category(db.session, other_id, "Theirs", "expense")
        db.session.commit()
        tid, tslug = theirs.id, theirs.slug
    h = _admin(client, test_store_id)
    assert client.put(f"{CATS}/{tid}", json={"name": "Mine"}, headers=h).status_code == 404
    assert client.post(f"{CATS}/{tid}/archive", headers=h).status_code == 404
    assert client.get(CATS, headers=h).get_json()["rows"] == []
    acct = _account(test_store_id)
    txn = _bank(test_store_id, acct, -100, datetime(Y, M, 6))
    assert _categorize(client, test_store_id, txn, tslug).status_code == 422

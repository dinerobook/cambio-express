"""The Transactions page's receipt view: cashier names, no-sale
events, the kind tabs and the department on each line.

Synthetic fixtures only — never real Gilbarco journal data.

* Passport names a cashier only by number. The store names them once
  (``/posimport/cashiers``) and every ticket shows the name; a search
  for the name finds the tickets.
* A drawer opened with nothing sold is an OtherEvent whose alert says
  "NoSale". It is parsed, stored and listed under its own tab, and,
  like every non-sale event, never summed.
* The tabs carry counts over the same range and search.
* The migration (d7a3f9c2e5b8) matches the models, imports no
  application code and runs up and down twice.
"""
import importlib.util
from datetime import date, datetime
from pathlib import Path

import pytest

from api.Modules.Audit.Models import OperatorAuditLog
from api.Modules.DayClose.Models import Department
from api.Modules.PosImport.Models import (
    PosCashier, PosMerchandiseMap, PosTransaction, PosTransactionLine,
)
from api.Modules.PosImport.Services import parse_pjr
from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client

DAY = date(2025, 12, 8)
ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "alembic" / "versions" / "d7a3f9c2e5b8_add_pos_cashier_names_and_no_sale.py"

NO_DAY_CLOSE_UPDATE = {
    "day_close": {
        "create": False, "read": True, "update": False, "delete": False,
    },
}
NO_DAY_CLOSE_READ = {
    "day_close": {
        "create": False, "read": False, "update": False, "delete": False,
    },
}


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _admin(client, store_id):
    return _headers(login_admin(client, store_id))


def _ticket(store_id, *, source_file, no, kind="sale", cashier="91",
            detail_type="", voided=False, cents=300, hour=13,
            merch="10", description="CANDY BAR"):
    txn = PosTransaction(
        store_id=store_id, business_date=DAY, source_file=source_file,
        kind=kind, register_id="1", cashier_id=cashier, till_id="7",
        transaction_no=no, event_sequence_id="1",
        started_at=datetime(2025, 12, 8, hour, 0, 0),
        receipt_at=None if kind == "other" else datetime(2025, 12, 8, hour, 0, 5),
        gross_cents=cents, net_cents=cents, tax_cents=0,
        grand_total_cents=cents, has_voided_line=voided,
        detail_type=detail_type,
    )
    db.session.add(txn)
    db.session.flush()
    if kind != "other":
        db.session.add(PosTransactionLine(
            transaction_id=txn.id, store_id=store_id, business_date=DAY,
            line_seq=1, status="normal", pos_code="222222222222",
            description=description, quantity=1.0, amount_cents=cents,
            actual_price_cents=cents, regular_price_cents=cents,
            merchandise_code=merch,
        ))
    db.session.flush()
    return txn.id


@pytest.fixture()
def day(client, test_store_id):
    """One business day: two sales (one with a voided item), a refund,
    a void, a no-sale and a register open."""
    with db_session():
        ids = {
            "sale": _ticket(test_store_id, source_file="S1.xml", no="100", hour=9),
            "voided": _ticket(test_store_id, source_file="S2.xml", no="101",
                              voided=True, cashier="92", hour=10,
                              description="COFFEE LARGE"),
            "refund": _ticket(test_store_id, source_file="R1.xml", no="102",
                              kind="refund", cents=-150, hour=11),
            "void": _ticket(test_store_id, source_file="V1.xml", no="103",
                            kind="void", cents=999, hour=12),
            "no_sale": _ticket(test_store_id, source_file="N1.xml", no="104",
                               kind="other", detail_type="NoSale", hour=14),
            "open": _ticket(test_store_id, source_file="O1.xml", no="105",
                            kind="other", detail_type="open", hour=6),
        }
        db.session.commit()
    return ids


def _list(client, headers, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get(
        "/api/v2/posimport/transactions"
        f"?start={DAY.isoformat()}&end={DAY.isoformat()}"
        + (f"&{query}" if query else ""),
        headers=headers,
    )


# ── Parsing a no-sale ──────────────────────────────────────


def _other(body: str) -> str:
    return f"""<?xml version="1.0" encoding="ISO-8859-1"?>
<NAXML-POSJournal version="3.4">
 <JournalReport>
  <OtherEvent>
   <EventSequenceID>1</EventSequenceID>
   <TransactionID>4035</TransactionID>
   <CashierID>91</CashierID>
   <RegisterID>1</RegisterID>
   <TillID>7</TillID>
   <EventStartDate>2025-12-08</EventStartDate>
   <EventStartTime>14:00:00</EventStartTime>
   <EventEndDate>2025-12-08</EventEndDate>
   <EventEndTime>14:00:03</EventEndTime>
   <BusinessDate>2025-12-08</BusinessDate>
   {body}
  </OtherEvent>
 </JournalReport>
</NAXML-POSJournal>"""


def test_a_no_sale_alert_is_read_as_its_own_detail_type():
    ev = parse_pjr(_other("""<AlertDetail>
     <DeviceID>1</DeviceID>
     <Description>NoSale</Description>
    </AlertDetail>"""))
    assert ev.kind == "other"
    assert ev.detail_type == "NoSale"
    assert ev.counts_toward_sales is False


def test_a_register_open_or_close_keeps_its_detail_type():
    opened = parse_pjr(_other(
        '<RegisterDetail detailType="open"><CashInDrawer>500</CashInDrawer></RegisterDetail>'
    ))
    closed = parse_pjr(_other(
        '<RegisterDetail detailType="close"><CashInDrawer>812.40</CashInDrawer></RegisterDetail>'
    ))
    assert (opened.detail_type, opened.opening_cash_cents) == ("open", 50000)
    assert (closed.detail_type, closed.opening_cash_cents) == ("close", None)


def test_a_sale_has_no_detail_type():
    from tests.Modules.PosImport.test_naxml import _sale
    assert parse_pjr(_sale()).detail_type == ""


# ── Tabs ───────────────────────────────────────────────────


def test_tabs_count_every_kind_over_the_same_range(client, test_store_id, day):
    body = _list(client, _admin(client, test_store_id)).json()
    assert body["kind_counts"] == {
        "all": 6, "sale": 2, "refund": 1, "void": 1,
        "voided_items": 1, "no_sale": 1,
    }


def test_the_no_sale_tab_lists_only_no_sales_and_rings_nothing(
    client, test_store_id, day,
):
    body = _list(client, _admin(client, test_store_id), kind="no_sale").json()
    assert [r["transaction_no"] for r in body["rows"]] == ["104"]
    row = body["rows"][0]
    assert row["detail_type"] == "NoSale"
    # No receipt is printed: the start time stands in.
    assert row["receipt_at"] is None
    assert row["started_at"] == "2025-12-08T14:00:00"
    assert body["total_grand"] == pytest.approx(0.0)
    # The counts don't follow the tab: they describe every tab.
    assert body["kind_counts"]["all"] == 6


def test_events_without_a_receipt_sort_by_their_start_time(
    client, test_store_id, day,
):
    rows = _list(client, _admin(client, test_store_id)).json()["rows"]
    # 14:00 no-sale, 12:00 void, 11:00 refund, 10:00, 9:00, 6:00 open.
    assert [r["transaction_no"] for r in rows] == [
        "104", "103", "102", "101", "100", "105",
    ]


def test_an_unknown_kind_is_refused(client, test_store_id, day):
    resp = _list(client, _admin(client, test_store_id), kind="lottery")
    assert resp.status_code == 422


def test_search_narrows_the_tab_counts_too(client, test_store_id, day):
    body = _list(client, _admin(client, test_store_id), q="coffee").json()
    assert body["kind_counts"]["all"] == 1
    assert body["kind_counts"]["voided_items"] == 1


# ── Cashier names ──────────────────────────────────────────


def _put_names(client, headers, names):
    return client.put(
        "/api/v2/posimport/cashiers",
        json={"cashiers": [
            {"cashier_id": cid, "name": name} for cid, name in names.items()
        ]},
        headers=headers,
    )


def test_cashier_list_has_every_number_busiest_first(client, test_store_id, day):
    resp = client.get(
        "/api/v2/posimport/cashiers", headers=_admin(client, test_store_id),
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert [(r["cashier_id"], r["ticket_count"], r["name"]) for r in rows] == [
        ("91", 5, ""), ("92", 1, ""),
    ]
    assert rows[0]["last_seen"] == DAY.isoformat()


def test_naming_a_cashier_shows_on_tickets_and_is_audited(
    client, test_store_id, day,
):
    h = _admin(client, test_store_id)
    resp = _put_names(client, h, {"91": "  Tania   Cerrato ", "92": "Noel"})
    assert resp.status_code == 200, resp.text
    assert {r["cashier_id"]: r["name"] for r in resp.json()["rows"]} == {
        "91": "Tania Cerrato", "92": "Noel",
    }

    rows = _list(client, h).json()["rows"]
    by_no = {r["transaction_no"]: r for r in rows}
    assert by_no["100"]["cashier_name"] == "Tania Cerrato"
    assert by_no["101"]["cashier_name"] == "Noel"

    detail = client.get(
        f"/api/v2/posimport/transactions/{day['voided']}", headers=h,
    ).json()["transaction"]
    assert detail["cashier_name"] == "Noel"

    with db_session():
        actions = [
            a.action for a in
            db.session.query(OperatorAuditLog).filter_by(store_id=test_store_id)
        ]
    assert "set_pos_cashier_names" in actions


def test_search_finds_tickets_by_cashier_name(client, test_store_id, day):
    h = _admin(client, test_store_id)
    _put_names(client, h, {"92": "Noel Diaz"})
    body = _list(client, h, q="noel").json()
    assert [r["transaction_no"] for r in body["rows"]] == ["101"]


def test_a_blank_name_forgets_the_cashier(client, test_store_id, day):
    h = _admin(client, test_store_id)
    _put_names(client, h, {"91": "Tania"})
    resp = _put_names(client, h, {"91": "   "})
    assert resp.status_code == 200
    with db_session():
        assert db.session.query(PosCashier).filter_by(
            store_id=test_store_id,
        ).count() == 0
    rows = _list(client, h).json()["rows"]
    assert {r["cashier_name"] for r in rows} == {""}


def test_names_stay_in_their_own_store(client, test_store_id, day):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="other-cashiers", email="o@x.test",
                      plan="pro", is_active=True)
        db.session.add(other)
        db.session.flush()
        db.session.add(PosCashier(store_id=other.id, cashier_id="91", name="Not yours"))
        db.session.commit()
    rows = _list(client, _admin(client, test_store_id)).json()["rows"]
    assert "Not yours" not in {r["cashier_name"] for r in rows}


def test_a_cashier_with_read_only_access_can_list_but_not_name(
    client, test_store_id, day,
):
    emp_client, token = make_employee_client(
        test_store_id, permissions=NO_DAY_CLOSE_UPDATE,
    )
    h = _headers(token)
    assert emp_client.get("/api/v2/posimport/cashiers", headers=h).status_code == 200
    assert _put_names(emp_client, h, {"91": "Me"}).status_code == 403


def test_without_day_close_read_the_cashier_list_is_refused(
    client, test_store_id, day,
):
    emp_client, token = make_employee_client(
        test_store_id, permissions=NO_DAY_CLOSE_READ,
    )
    resp = emp_client.get("/api/v2/posimport/cashiers", headers=_headers(token))
    assert resp.status_code == 403


def test_a_name_too_long_or_a_missing_number_is_refused(client, test_store_id):
    h = _admin(client, test_store_id)
    assert _put_names(client, h, {"91": "x" * 81}).status_code == 422
    resp = client.put(
        "/api/v2/posimport/cashiers",
        json={"cashiers": [{"cashier_id": "", "name": "Nobody"}]},
        headers=h,
    )
    assert resp.status_code == 422


def test_anonymous_cannot_read_or_name_cashiers(client):
    assert client.get("/api/v2/posimport/cashiers").status_code == 401
    assert client.put(
        "/api/v2/posimport/cashiers", json={"cashiers": []},
    ).status_code == 401


# ── Department on each line ────────────────────────────────


def test_each_line_names_its_department(client, test_store_id, day):
    with db_session():
        dept = Department(store_id=test_store_id, name="Grocery")
        db.session.add(dept)
        db.session.flush()
        db.session.add(PosMerchandiseMap(
            store_id=test_store_id, merchandise_code="10", department_id=dept.id,
        ))
        db.session.commit()
    detail = client.get(
        f"/api/v2/posimport/transactions/{day['sale']}",
        headers=_admin(client, test_store_id),
    ).json()["transaction"]
    assert [l["department_name"] for l in detail["lines"]] == ["Grocery"]


def test_an_unmapped_department_number_has_no_name(client, test_store_id, day):
    detail = client.get(
        f"/api/v2/posimport/transactions/{day['sale']}",
        headers=_admin(client, test_store_id),
    ).json()["transaction"]
    assert [l["department_name"] for l in detail["lines"]] == [""]


# ── The commit stores the detail type ──────────────────────


def test_rebuild_stores_the_detail_type(test_store_id):
    from api.Modules.PosImport.Services.ingest import rebuild_transactions
    ev = parse_pjr(_other(
        "<AlertDetail><Description>NoSale</Description></AlertDetail>"
    ))
    ev.source_file = "PJR-nosale.xml"
    with db_session():
        rebuild_transactions(db.session, test_store_id, DAY, [ev])
        db.session.commit()
        row = db.session.query(PosTransaction).filter_by(
            store_id=test_store_id, source_file="PJR-nosale.xml",
        ).one()
        assert (row.kind, row.detail_type) == ("other", "NoSale")


# ── The migration ──────────────────────────────────────────


def _migration():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_imports_no_application_code():
    for line in MIGRATION.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_matches_the_models():
    m = _migration()
    name, type_, _default = m.DETAIL_COLUMN
    column = PosTransaction.__table__.columns[name]
    assert type(column.type) is type(type_)
    assert column.type.length == type_.length
    assert column.nullable is False

    table = PosCashier.__table__
    assert table.name == m.CASHIER_TABLE
    migration_cols = {c.name: c for c in m._cashier_columns()}
    assert list(migration_cols) == [c.name for c in table.columns]
    for col in table.columns:
        other = migration_cols[col.name]
        assert type(other.type) is type(col.type), col.name
        assert other.nullable == col.nullable, col.name
    uniques = {
        c.name for c in table.constraints
        if c.__class__.__name__ == "UniqueConstraint"
    }
    assert m.CASHIER_UNIQUE in uniques


def test_migration_runs_up_and_down_twice_and_keeps_old_rows(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect, text

    m = _migration()
    url = f"sqlite:///{tmp_path / 'cashiers.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def columns():
        return {c["name"] for c in inspect(engine).get_columns(m.TRANSACTION_TABLE)}

    def tables():
        return set(inspect(engine).get_table_names())

    command.upgrade(cfg, m.down_revision)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO retail_pos_transaction (store_id, business_date, "
            "source_file, kind, register_id, cashier_id, till_id, "
            "transaction_no, event_sequence_id, outside, training_mode, "
            "offline, suspended, gross_cents, net_cents, tax_cents, "
            "grand_total_cents, has_voided_line, linked_reason, "
            "linked_register_id, linked_transaction_no, superseded, "
            "superseded_by_file) VALUES (1, :d, 'PJR-old.xml', 'other', "
            "'1', '91', '', '8945', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, '', '', "
            "'', 0, '')"
        ), {"d": date(2025, 3, 4)})

    for _ in range(2):
        command.upgrade(cfg, m.revision)
        assert "detail_type" in columns()
        assert m.CASHIER_TABLE in tables()
    with engine.connect() as conn:
        assert conn.execute(text(
            "SELECT detail_type FROM retail_pos_transaction"
        )).one() == ("",)

    for _ in range(2):
        command.downgrade(cfg, m.down_revision)
        assert "detail_type" not in columns()
        assert m.CASHIER_TABLE not in tables()
    with engine.connect() as conn:
        assert conn.execute(text(
            "SELECT COUNT(*) FROM retail_pos_transaction"
        )).scalar() == 1

    command.upgrade(cfg, m.revision)

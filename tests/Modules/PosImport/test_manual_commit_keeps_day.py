"""A manual NAXML commit must never lose what is already stored for
the day.

The commit rebuilds the day's transactions, hourly buckets and item
movement from the events it is given. A manual upload's events had no
``source_file`` (so every transaction was deleted and none written),
and the rebuild ignored the day's staged agent files the upload did
not repeat. Separately, a re-commit wiped the drawer count and notes
a cashier entered on the imported close.
"""
import base64
import io
import zipfile

from tests._app import db, db_session
from tests.Modules.PosImport.test_agent import _agent_upload, _issue_key
from tests.Modules.PosImport.test_ingest import _mk_department, _map_codes
from tests.Modules.PosImport.test_naxml import _sale
from tests.Modules.PosImport.test_transaction_persistence import (
    SALE_WITH_VOIDED_ITEM,
)
from tests.conftest import login_admin

DAY = "2025-12-08"
# Two different sales on the same business day, in different hours.
DOC_A = SALE_WITH_VOIDED_ITEM                       # 13:30, $3.00 cash
DOC_B = _sale(business_date=DAY, merch="10",
              event_dt="2025-12-08T09:15:00")       # 09:15, $2.99 cash


def _h(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def _zip(**members):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, doc in members.items():
            z.writestr(name, doc.encode("ISO-8859-1"))
    return base64.b64encode(buf.getvalue()).decode()


def _single(doc):
    return base64.b64encode(doc.encode("ISO-8859-1")).decode()


def _manual_commit(client, h, content_b64):
    resp = client.post("/api/v2/posimport/naxml/commit", headers=h,
                       json={"content_base64": content_b64, "day": DAY})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _stored(store_id):
    """(transactions, hourly buckets, item rows, Register 1 close)."""
    from datetime import date
    from api.Modules.DayClose.Models import HourlySale, RegisterClose
    from api.Modules.PosImport.Models import PosItemDaySale, PosTransaction
    day = date.fromisoformat(DAY)
    with db_session():
        txns = sorted(
            t.source_file for t in db.session.query(PosTransaction)
            .filter_by(store_id=store_id, business_date=day)
        )
        hourly = {
            h.hour: h.amount_cents for h in db.session.query(HourlySale)
            .filter_by(store_id=store_id, report_date=day)
        }
        items = {
            i.pos_code: i.amount_cents for i in db.session.query(PosItemDaySale)
            .filter_by(store_id=store_id, business_date=day)
        }
        rc = db.session.query(RegisterClose).filter_by(
            store_id=store_id, report_date=day,
            register_label="Register 1",
        ).one()
        close = (rc.gross_sales_cents, rc.cash_counted, rc.notes)
    return txns, hourly, items, close


def _staged_day(client, store_id):
    h = _h(client, store_id)
    key = _issue_key(client, h)["key"]
    assert _agent_upload(client, key, "PJR-A.xml", DOC_A).status_code == 200
    assert _agent_upload(client, key, "PJR-B.xml", DOC_B).status_code == 200
    dept = _mk_department(client, h, "Grocery")
    _map_codes(client, h, {"10": dept["id"]})
    resp = client.post("/api/v2/posimport/staged/commit", headers=h,
                       json={"day": DAY})
    assert resp.status_code == 200, resp.text
    return h


def test_manual_commit_after_staged_commit_keeps_the_day(
    client, test_store_id,
):
    h = _staged_day(client, test_store_id)
    before = _stored(test_store_id)
    assert before[0] == ["PJR-A.xml", "PJR-B.xml"]
    assert set(before[1]) == {9, 13}
    assert set(before[2]) == {"2", "222222222222"}

    # Re-upload only file A (same name) by hand.
    _manual_commit(client, h, _zip(**{"PJR-A.xml": DOC_A}))
    assert _stored(test_store_id) == before


def test_manual_copy_under_another_name_is_not_counted_twice(
    client, test_store_id,
):
    h = _staged_day(client, test_store_id)
    before = _stored(test_store_id)
    # The same bytes renamed inside a ZIP, and as a single-file upload.
    _manual_commit(client, h, _zip(**{"export/renamed.xml": DOC_A}))
    after = _stored(test_store_id)
    assert after[1:] == before[1:]          # hourly / items / close
    assert len(after[0]) == 2
    _manual_commit(client, h, _single(DOC_B))
    after = _stored(test_store_id)
    assert after[1:] == before[1:]
    assert len(after[0]) == 2


def test_manual_commit_without_agent_persists_transactions(
    client, test_store_id,
):
    """No staged files: the upload alone is the day, and its
    transactions are now stored (they used to be skipped)."""
    h = _h(client, test_store_id)
    dept = _mk_department(client, h, "Grocery")
    _map_codes(client, h, {"10": dept["id"]})
    _manual_commit(client, h, _zip(**{"PJR-A.xml": DOC_A}))
    txns, hourly, items, close = _stored(test_store_id)
    assert txns == ["PJR-A.xml"]
    assert set(hourly) == {13}
    assert close[0] == 300
    # A single-file upload is keyed by its content and stays idempotent.
    _manual_commit(client, h, _single(DOC_A))
    _manual_commit(client, h, _single(DOC_A))
    txns, _, _, close = _stored(test_store_id)
    assert len(txns) == 1 and txns[0].startswith("upload-")
    assert close[0] == 300


def test_recommit_keeps_cash_counted_and_typed_notes(client, test_store_id):
    from api.Modules.DayClose.Models import RegisterClose
    h = _staged_day(client, test_store_id)
    with db_session():
        rc = db.session.query(RegisterClose).filter_by(
            store_id=test_store_id, register_label="Register 1",
        ).one()
        assert rc.notes.startswith("Imported from Gilbarco journal")
        rc.cash_counted = 3.00
        rc.notes = "Drawer short — manager notified"
        db.session.commit()
    for _ in range(2):
        client.post("/api/v2/posimport/staged/commit", headers=h,
                    json={"day": DAY})
        _manual_commit(client, h, _zip(**{"PJR-A.xml": DOC_A}))
    _, _, _, close = _stored(test_store_id)
    assert close[1] == 3.00
    assert close[2] == "Drawer short — manager notified"


def test_recommit_refreshes_an_untouched_import_note(client, test_store_id):
    from api.Modules.DayClose.Models import RegisterClose
    h = _h(client, test_store_id)
    dept = _mk_department(client, h, "Grocery")
    _map_codes(client, h, {"10": dept["id"]})
    _manual_commit(client, h, _zip(**{"PJR-A.xml": DOC_A}))
    _manual_commit(client, h, _zip(**{"PJR-A.xml": DOC_A,
                                      "PJR-B.xml": DOC_B}))
    with db_session():
        rc = db.session.query(RegisterClose).filter_by(
            store_id=test_store_id, register_label="Register 1",
        ).one()
        assert rc.notes == "Imported from Gilbarco journal — 2 sales"
        assert rc.cash_counted is None


def test_is_import_note():
    from api.Modules.PosImport.Services.ingest import _is_import_note
    assert _is_import_note("")
    assert _is_import_note(None)
    assert _is_import_note("Imported from Gilbarco journal — 4 sales")
    assert _is_import_note(
        "Imported from Gilbarco journal — 4 sales, 1 refunds")
    assert not _is_import_note(
        "Imported from Gilbarco journal — 4 sales. Short $2")
    assert not _is_import_note("Cashier note")

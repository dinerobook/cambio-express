"""Platform ticket list: search, store filter and paging for the
superadmin tickets page (``GET /tickets/all``).
"""
from datetime import datetime

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin


@pytest.fixture
def sa_headers(client):
    return {"Authorization": f"Bearer {login_superadmin(client)}"}


def _mk_store(name):
    from api.Modules.Tenancy.Models import Store
    stamp = datetime.utcnow().timestamp()
    with db_session():
        s = Store(name=name, slug=f"tk-{stamp}", plan="trial")
        db.session.add(s)
        db.session.commit()
        return s.id


def _mk_ticket(store_id, subject, *, submitted_by="someone", status="open"):
    from api.Modules.Support.Models import SupportTicket
    from api.Modules.Tenancy.Models import User
    with db_session():
        uid = db.session.query(User.id).filter_by(username="admin@test.com").scalar()
        t = SupportTicket(
            store_id=store_id, user_id=uid, submitted_by=submitted_by,
            subject=subject, body="body", category="question",
            status=status, priority="P3",
            created_at=datetime.utcnow(),
        )
        db.session.add(t)
        db.session.commit()
        return t.id


def _all(client, sa_headers, **params):
    resp = client.get("/api/v2/tickets/all", headers=sa_headers, query_string=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestSearch:
    def test_q_matches_subject_submitter_and_store_name(self, client, sa_headers):
        a = _mk_store("Zebra Mart Unique")
        b = _mk_store("Other Store")
        t1 = _mk_ticket(a, "Printer jammed again")
        t2 = _mk_ticket(b, "Login trouble", submitted_by="zebra.keeper")
        t3 = _mk_ticket(b, "Unrelated")
        ids = {t["id"] for t in _all(client, sa_headers, q="zebra")["tickets"]}
        assert t1 in ids and t2 in ids and t3 not in ids
        ids = {t["id"] for t in _all(client, sa_headers, q="jammed")["tickets"]}
        assert ids == {t1}

    def test_store_filter(self, client, sa_headers):
        a, b = _mk_store("A"), _mk_store("B")
        t1 = _mk_ticket(a, "one")
        _mk_ticket(b, "two")
        body = _all(client, sa_headers, store_id=a)
        assert [t["id"] for t in body["tickets"]] == [t1]
        assert body["total"] == 1

    def test_pages_with_total_reflecting_filters(self, client, sa_headers):
        sid = _mk_store("Pager Store")
        for i in range(7):
            _mk_ticket(sid, f"paged {i}")
        first = _all(client, sa_headers, store_id=sid, per_page=5)
        assert first["total"] == 7
        assert first["total_pages"] == 2
        assert len(first["tickets"]) == 5
        second = _all(client, sa_headers, store_id=sid, per_page=5, page=2)
        assert second["page"] == 2
        assert len(second["tickets"]) == 2
        assert not {t["id"] for t in first["tickets"]} & {
            t["id"] for t in second["tickets"]
        }

    def test_short_q_is_ignored_not_an_error(self, client, sa_headers):
        sid = _mk_store("Short Q")
        _mk_ticket(sid, "anything")
        body = _all(client, sa_headers, store_id=sid, q="a")
        assert body["total"] == 1

    def test_store_admin_is_still_refused(self, client, test_store_id):
        token = login_admin(client, test_store_id)
        resp = client.get(
            "/api/v2/tickets/all", headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

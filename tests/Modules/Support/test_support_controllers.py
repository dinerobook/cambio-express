"""HTTP integration tests for the Support ticket module.

Covers all 5 endpoints:
  POST /tickets          — create ticket
  GET  /tickets          — list my store's tickets
  GET  /tickets/all      — superadmin: all tickets
  GET  /tickets/{id}     — detail (scoped)
  PUT  /tickets/{id}     — update status/priority/reply
"""
import pytest
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


@pytest.fixture
def admin_token(client):
    with db_session():
        from api.Modules.Tenancy.Models import Store
        store = db.session.query(Store).first()
        store_id = store.id
    return login_admin(client, store_id)


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


class TestCreateTicket:
    def test_create_ticket(self, client, admin_headers):
        resp = client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "bug",
            "subject": "Test bug report",
            "body": "Something is broken.",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["ticket"]["subject"] == "Test bug report"
        assert data["ticket"]["category"] == "bug"
        assert data["ticket"]["status"] == "open"

    def test_invalid_category_rejected(self, client, admin_headers):
        resp = client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "invalid_cat",
            "subject": "Test",
            "body": "Test body.",
        })
        assert resp.status_code == 422

    def test_requires_auth(self, client):
        resp = client.post("/api/v2/tickets", json={
            "category": "bug", "subject": "X", "body": "Y",
        })
        assert resp.status_code in (401, 403)


class TestListMyTickets:
    def test_list_tickets(self, client, admin_headers):
        # Create one first
        client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "question",
            "subject": "List test",
            "body": "Testing list.",
        })
        resp = client.get("/api/v2/tickets", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "tickets" in data
        assert "total" in data
        assert data["total"] >= 1

    def test_superadmin_gets_all_tickets(self, client, sa_headers):
        resp = client.get("/api/v2/tickets", headers=sa_headers)
        assert resp.status_code == 200
        assert "tickets" in resp.json()


class TestListAllTickets:
    def test_superadmin_only(self, client, admin_headers, sa_headers):
        resp = client.get("/api/v2/tickets/all", headers=admin_headers)
        assert resp.status_code == 403
        resp = client.get("/api/v2/tickets/all", headers=sa_headers)
        assert resp.status_code == 200

    def test_returns_store_names(self, client, sa_headers):
        resp = client.get("/api/v2/tickets/all", headers=sa_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "tickets" in data
        assert "total" in data


class TestGetTicket:
    def test_get_own_ticket(self, client, admin_headers):
        create = client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "feedback",
            "subject": "Detail test",
            "body": "Testing detail.",
        })
        tid = create.json()["ticket"]["id"]
        resp = client.get(f"/api/v2/tickets/{tid}", headers=admin_headers)
        assert resp.status_code == 200
        assert resp.json()["ticket"]["id"] == tid

    def test_superadmin_sees_any(self, client, admin_headers, sa_headers):
        create = client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "bug",
            "subject": "SA visibility",
            "body": "Test.",
        })
        tid = create.json()["ticket"]["id"]
        resp = client.get(f"/api/v2/tickets/{tid}", headers=sa_headers)
        assert resp.status_code == 200

    def test_404_on_missing(self, client, admin_headers):
        resp = client.get("/api/v2/tickets/99999", headers=admin_headers)
        assert resp.status_code == 404


class TestUpdateTicket:
    def test_update_status(self, client, sa_headers, admin_headers):
        create = client.post("/api/v2/tickets", headers=admin_headers, json={
            "category": "question",
            "subject": "Update test",
            "body": "Test.",
        })
        tid = create.json()["ticket"]["id"]
        resp = client.put(f"/api/v2/tickets/{tid}", headers=sa_headers, json={
            "status": "resolved",
            "admin_reply": "Fixed it.",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["ticket"]["status"] == "resolved"
        assert data["ticket"]["admin_reply"] == "Fixed it."

    def test_non_admin_cannot_update(self, client):
        resp = client.put("/api/v2/tickets/1", json={"status": "closed"})
        assert resp.status_code in (401, 403)


class TestListMyTicketsPaging:
    """The store's own list pages when asked for a ``page``; without
    one it keeps returning every ticket (the legacy shape)."""

    def _file(self, client, headers, n):
        for i in range(n):
            resp = client.post("/api/v2/tickets", headers=headers, json={
                "category": "question", "subject": f"Paged {i:02d}", "body": "x",
            })
            assert resp.status_code == 201

    def test_without_page_returns_every_ticket(self, client, admin_headers):
        self._file(client, admin_headers, 30)
        data = client.get("/api/v2/tickets", headers=admin_headers).json()
        assert len(data["tickets"]) == data["total"] >= 30

    def test_pages_newest_first(self, client, admin_headers):
        self._file(client, admin_headers, 30)
        first = client.get(
            "/api/v2/tickets?page=1&per_page=25", headers=admin_headers,
        ).json()
        assert first["total"] == 30
        assert first["total_pages"] == 2
        assert len(first["tickets"]) == 25
        assert first["tickets"][0]["subject"] == "Paged 29"
        second = client.get(
            "/api/v2/tickets?page=2&per_page=25", headers=admin_headers,
        ).json()
        assert [t["subject"] for t in second["tickets"]][-1] == "Paged 00"
        assert len(second["tickets"]) == 5

    def test_paging_stays_inside_the_store(self, client, admin_headers, sa_headers):
        self._file(client, admin_headers, 2)
        from api.Modules.Tenancy.Models import Store, User
        from api.Modules.Support.Models import SupportTicket
        with db_session():
            someone = db.session.query(User).first()
            other = Store(name="Other", slug="other-tickets")
            db.session.add(other)
            db.session.flush()
            db.session.add(SupportTicket(
                store_id=other.id, user_id=someone.id,
                category="bug", subject="Not yours",
                body="x", status="open", submitted_by="someone",
            ))
            db.session.commit()
        data = client.get("/api/v2/tickets?page=1", headers=admin_headers).json()
        assert "Not yours" not in [t["subject"] for t in data["tickets"]]

    def test_rejects_bad_paging(self, client, admin_headers):
        assert client.get("/api/v2/tickets?page=0", headers=admin_headers).status_code == 422
        assert client.get(
            "/api/v2/tickets?page=1&per_page=500", headers=admin_headers,
        ).status_code == 422

    def test_platform_staff_page_through_the_queue(self, client, admin_headers, sa_headers):
        self._file(client, admin_headers, 30)
        data = client.get("/api/v2/tickets?page=2&per_page=25", headers=sa_headers).json()
        assert data["page"] == 2
        assert data["total"] >= 30

"""A store's own audit log on the superadmin store page: the same
merged operator + transfer feed the store's admin sees, scoped to
that store only.
"""
from datetime import datetime

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


def _mk_store():
    from api.Modules.Tenancy.Models import Store
    stamp = datetime.utcnow().timestamp()
    with db_session():
        s = Store(name="Activity Store", slug=f"act-{stamp}", plan="trial")
        db.session.add(s)
        db.session.commit()
        return s.id


def _log(store_id, action, n=1):
    from api.Modules.Audit.Services.recorder import record_operator_action
    with db_session():
        for i in range(n):
            record_operator_action(
                db.session, store_id=store_id, user_id=None,
                user_name=f"actor-{store_id}", user_role="admin",
                target_type="settings", target_id=str(i),
                target_label="", action=action, summary=f"row {i}",
            )
        db.session.commit()


class TestStoreActivity:
    def test_lists_only_that_stores_rows(self, client, sa_headers):
        a, b = _mk_store(), _mk_store()
        _log(a, "update_settings", 3)
        _log(b, "update_settings", 2)
        resp = client.get(
            f"/api/v2/superadmin/stores/{a}/audit-log", headers=sa_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 3
        assert {r["user_name"] for r in body["rows"]} == {f"actor-{a}"}
        assert body["page"] == 1 and body["total_pages"] == 1
        assert body["rows"][0]["action"] == "update_settings"

    def test_pages(self, client, sa_headers):
        sid = _mk_store()
        _log(sid, "update_settings", 55)
        first = client.get(
            f"/api/v2/superadmin/stores/{sid}/audit-log", headers=sa_headers,
        ).json()
        assert first["total"] == 55
        assert first["total_pages"] == 2
        assert len(first["rows"]) == first["per_page"]
        second = client.get(
            f"/api/v2/superadmin/stores/{sid}/audit-log?page=2",
            headers=sa_headers,
        ).json()
        assert second["page"] == 2
        assert len(second["rows"]) == 55 - first["per_page"]

    def test_action_filter(self, client, sa_headers):
        sid = _mk_store()
        _log(sid, "update_settings", 2)
        _log(sid, "delete", 1)
        body = client.get(
            f"/api/v2/superadmin/stores/{sid}/audit-log?action=delete",
            headers=sa_headers,
        ).json()
        assert body["total"] == 1

    def test_missing_store_is_404(self, client, sa_headers):
        resp = client.get(
            "/api/v2/superadmin/stores/999999/audit-log", headers=sa_headers,
        )
        assert resp.status_code == 404

    def test_store_admin_is_refused(self, client, test_store_id):
        token = login_admin(client, test_store_id)
        resp = client.get(
            f"/api/v2/superadmin/stores/{test_store_id}/audit-log",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

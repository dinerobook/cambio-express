"""One store-centric view of every module, add-on and flag: what the
store gets by default, whether a superadmin overrode it, and what
the store's users actually see right now.

Before this endpoint the only way to turn a module on for ONE
customer was Feature flags → pick the flag → add an override by
store, with nothing on the store's own page saying which modules
it had.
"""
from datetime import datetime

import pytest

from tests._app import db, db_session
from tests.conftest import login_superadmin


@pytest.fixture
def sa_token(client):
    return login_superadmin(client)


@pytest.fixture
def sa_headers(sa_token):
    return {"Authorization": f"Bearer {sa_token}"}


@pytest.fixture(autouse=True)
def _flags_seeded():
    from api.Core.Bootstrap import seed_feature_flags
    with db_session():
        seed_feature_flags(db.session)


def _mk_store(business_type="cstore"):
    from api.Modules.Tenancy.Models import Store
    stamp = datetime.utcnow().timestamp()
    with db_session():
        s = Store(name="Features Store", slug=f"feat-{stamp}",
                  plan="trial", business_type=business_type)
        db.session.add(s)
        db.session.commit()
        return s.id


def _rows(client, sa_headers, sid):
    resp = client.get(
        f"/api/v2/superadmin/stores/{sid}/features", headers=sa_headers,
    )
    assert resp.status_code == 200, resp.text
    return {r["key"]: r for r in resp.json()["rows"]}


class TestStoreFeatures:
    def test_lists_modules_with_bundle_defaults(self, client, sa_headers):
        rows = _rows(client, sa_headers, _mk_store("cstore"))
        money = rows["module_money_services"]
        assert money["kind"] == "module"
        assert money["label"]
        assert money["default"] is False      # retail bundle
        assert money["override"] is None
        assert money["effective"] is False
        lottery = rows["module_lottery"]
        assert lottery["default"] is True
        assert lottery["effective"] is True

    def test_msb_bundle(self, client, sa_headers):
        rows = _rows(client, sa_headers, _mk_store("msb_hybrid"))
        assert rows["module_money_services"]["effective"] is True
        assert rows["module_lottery"]["effective"] is False

    def test_addons_and_platform_flags_are_listed_by_kind(
        self, client, sa_headers,
    ):
        rows = _rows(client, sa_headers, _mk_store())
        assert rows["addon_tv_display"]["kind"] == "addon"
        assert rows["bank_sync"]["kind"] == "flag"
        assert rows["bank_sync"]["default"] is True

    def test_override_shows_and_changes_effective(self, client, sa_headers):
        sid = _mk_store("cstore")
        resp = client.put(
            f"/api/v2/feature-flags/module_money_services/stores/{sid}",
            headers=sa_headers, json={"enabled": True},
        )
        assert resp.status_code == 200, resp.text
        money = _rows(client, sa_headers, sid)["module_money_services"]
        assert money["override"] is True
        assert money["effective"] is True
        assert money["default"] is False
        client.delete(
            f"/api/v2/feature-flags/module_money_services/stores/{sid}",
            headers=sa_headers,
        )
        money = _rows(client, sa_headers, sid)["module_money_services"]
        assert money["override"] is None
        assert money["effective"] is False

    def test_missing_store_is_404(self, client, sa_headers):
        resp = client.get(
            "/api/v2/superadmin/stores/999999/features", headers=sa_headers,
        )
        assert resp.status_code == 404

    def test_requires_superadmin(self, client, test_store_id):
        from tests.conftest import login_admin
        token = login_admin(client, test_store_id)
        resp = client.get(
            f"/api/v2/superadmin/stores/{test_store_id}/features",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

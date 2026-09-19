"""Business-type module bundles (P0-1, the pivot — HANDOFF.md §2).

``Store.business_type`` drives which product modules a store gets
by default, resolved through ``store_feature_enabled`` BETWEEN the
per-store override and the global flag default:

  override → business-type bundle (module_* only) → global → open

Plus the delivery path: /auth/session-status carries
``business_type`` + ``features`` so the SPA can gate nav; signup
and the superadmin store form set the type.
"""
from tests._app import db, db_session
from tests.conftest import login_admin, login_superadmin


def _headers(token):
    return {"Authorization": f"Bearer {token}"}


def _set_business_type(store_id, value):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = db.session.get(Store, store_id)
        s.business_type = value
        db.session.commit()


# ── Service-level resolution ───────────────────────────────


def test_cstore_bundle_disables_money_services(client, test_store_id):
    from api.Modules.Billing.Services import store_feature_enabled
    from api.Modules.Tenancy.Models import Store
    _set_business_type(test_store_id, "cstore")
    with db_session():
        store = db.session.get(Store, test_store_id)
        assert store_feature_enabled(
            db.session, store, "module_money_services",
        ) is False


def test_msb_hybrid_bundle_enables_money_services(client, test_store_id):
    from api.Modules.Billing.Services import store_feature_enabled
    from api.Modules.Tenancy.Models import Store
    _set_business_type(test_store_id, "msb_hybrid")
    with db_session():
        store = db.session.get(Store, test_store_id)
        assert store_feature_enabled(
            db.session, store, "module_money_services",
        ) is True


def test_override_beats_bundle(client, test_store_id):
    """Superadmin can flip a module ON for a c-store that does
    offer money services — the per-store override still wins."""
    from api.Modules.Billing.Models import StoreFeatureOverride
    from api.Modules.Billing.Services import store_feature_enabled
    from api.Modules.Tenancy.Models import Store
    _set_business_type(test_store_id, "cstore")
    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=test_store_id,
            flag_key="module_money_services",
            enabled=True,
        ))
        db.session.commit()
        store = db.session.get(Store, test_store_id)
        assert store_feature_enabled(
            db.session, store, "module_money_services",
        ) is True


def test_bundle_has_no_opinion_on_non_module_flags(client, test_store_id):
    """A c-store still fails open on undeclared non-module flags
    (CLAUDE.md invariant #6 unchanged)."""
    from api.Modules.Billing.Services import store_feature_enabled
    from api.Modules.Tenancy.Models import Store
    _set_business_type(test_store_id, "cstore")
    with db_session():
        store = db.session.get(Store, test_store_id)
        assert store_feature_enabled(
            db.session, store, "totally_undeclared_flag",
        ) is True


# ── /auth/session-status delivery ──────────────────────────


def test_session_status_carries_type_and_features(client, test_store_id):
    _set_business_type(test_store_id, "msb_hybrid")
    token = login_admin(client, test_store_id)
    body = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()
    assert body["business_type"] == "msb_hybrid"
    assert "module_money_services" in body["features"]


def test_session_status_cstore_drops_money_services(client, test_store_id):
    _set_business_type(test_store_id, "cstore")
    token = login_admin(client, test_store_id)
    body = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()
    assert body["business_type"] == "cstore"
    assert "module_money_services" not in body["features"]


def test_superadmin_gets_every_module(client):
    token = login_superadmin(client)
    body = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()
    assert body["business_type"] == ""
    assert "module_money_services" in body["features"]


# ── Signup sets the type ───────────────────────────────────


def _signup(client, email, **extra):
    return client.post("/api/v2/auth/signup", json={
        "store_name": "Corner Stop",
        "email": email,
        "password": "hunter2hunter2",
        **extra,
    })


def test_signup_sets_business_type(client):
    from api.Modules.Tenancy.Models import Store
    resp = _signup(client, "gas@example.com", business_type="gas_station")
    assert resp.status_code in (200, 201)
    with db_session():
        s = (
            db.session.query(Store)
            .filter(Store.email == "gas@example.com").one()
        )
        assert s.business_type == "gas_station"


def test_signup_defaults_to_cstore(client):
    from api.Modules.Tenancy.Models import Store
    resp = _signup(client, "default@example.com")
    assert resp.status_code in (200, 201)
    with db_session():
        s = (
            db.session.query(Store)
            .filter(Store.email == "default@example.com").one()
        )
        assert s.business_type == "cstore"


def test_signup_rejects_unknown_business_type(client):
    resp = _signup(client, "bogus@example.com", business_type="nightclub")
    assert resp.status_code == 422


# ── Superadmin store form ──────────────────────────────────


def test_superadmin_create_and_update_business_type(client):
    token = login_superadmin(client)
    created = client.post(
        "/api/v2/superadmin/stores", headers=_headers(token),
        json={
            "name": "Pivot Mart", "slug": "pivot-mart",
            "business_type": "grocery",
            "admin_password": "hunter2hunter2",
        },
    )
    assert created.status_code in (200, 201), created.text
    row = created.json()["store"]
    assert row["business_type"] == "grocery"
    sid = row["store_id"]

    updated = client.patch(
        f"/api/v2/superadmin/stores/{sid}", headers=_headers(token),
        json={"business_type": "cstore"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["store"]["business_type"] == "cstore"


# ── module_check_cashing (P1-11) ───────────────────────────


def test_check_cashing_on_for_every_type_override_wins(
    client, test_store_id,
):
    """Every business type cashes checks by default; the per-store
    override is the off switch for stores that don't."""
    from api.Modules.Billing.Services import store_feature_enabled
    from api.Modules.Billing.Models import StoreFeatureOverride
    from api.Modules.Tenancy.Models import Store

    for btype in ("cstore", "gas_station", "grocery", "msb_hybrid"):
        _set_business_type(test_store_id, btype)
        with db_session():
            store = db.session.get(Store, test_store_id)
            assert store_feature_enabled(
                db.session, store, "module_check_cashing",
            ) is True, btype

    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=test_store_id,
            flag_key="module_check_cashing",
            enabled=False,
        ))
        db.session.commit()
        store = db.session.get(Store, test_store_id)
        assert store_feature_enabled(
            db.session, store, "module_check_cashing",
        ) is False

    token = login_admin(client, test_store_id)
    body = client.get(
        "/api/v2/auth/session-status", headers=_headers(token),
    ).json()
    assert "module_check_cashing" not in body["features"]


def test_every_module_flag_is_seeded_as_a_feature_flag_row():
    """The superadmin turns a module on for ONE store through the
    per-store override, and that endpoint 404s on a key with no
    FeatureFlag row. Every module key must be in the boot seed, or
    a c-store that also sends money has no way to get its transfer
    pages back."""
    from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
    from api.Modules.Billing.Services.feature_flags import MODULE_FLAG_KEYS
    seeded = {key for key, _label, _desc, _enabled in DEFAULT_FEATURE_FLAGS}
    assert set(MODULE_FLAG_KEYS) <= seeded


def test_superadmin_can_turn_money_services_on_for_a_cstore(
    client, test_store_id,
):
    """End to end through the override endpoint (the earlier test
    inserts the row directly): seed the flags the way boot does,
    set the override, and the store's admin session sees the
    module again."""
    from api.Core.Bootstrap import seed_feature_flags

    def _features(token):
        resp = client.get(
            "/api/v2/auth/session-status",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        return resp.get_json()["features"]

    _set_business_type(test_store_id, "cstore")
    with db_session():
        seed_feature_flags(db.session)
    admin = login_admin(client, test_store_id)
    assert "module_money_services" not in _features(admin)

    sa = login_superadmin(client)
    resp = client.put(
        f"/api/v2/feature-flags/module_money_services/stores/{test_store_id}",
        headers={"Authorization": f"Bearer {sa}"},
        json={"enabled": True},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert "module_money_services" in _features(admin)

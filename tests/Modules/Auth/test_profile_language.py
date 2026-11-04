"""Per-person UI language (Spanish in the app, 2026-11-04).

``User.language`` is a nullable column: NULL means "never chosen", answered
as null, and the SPA keeps the device's language (English unless someone
pressed ES on the sign-in screen), so every existing person keeps the
English app until they pick Spanish. Covers the read default, the save path for each
role that has a profile (admin, employee), refusal of unknown values,
that one person's choice never touches another's, and that the
migration matches the model without importing app code.
"""
import pathlib

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def _user(username):
    from api.Modules.Tenancy.Models import User
    return db.session.query(User).filter_by(username=username).first()


def test_language_is_null_when_never_chosen(client, test_store_id):
    with db_session():
        u = _user("admin@test.com")
        assert u.language is None
    token = login_admin(client, test_store_id)
    body = client.get("/api/v2/auth/profile", headers=_hdr(token)).get_json()
    assert body["language"] is None


def test_unknown_stored_language_reads_as_never_chosen(client, test_store_id):
    """A hand-edited or partially migrated row can't strand a person
    on an unknown language."""
    with db_session():
        _user("admin@test.com").language = "fr"
        db.session.commit()
    token = login_admin(client, test_store_id)
    body = client.get("/api/v2/auth/profile", headers=_hdr(token)).get_json()
    assert body["language"] is None


def test_admin_can_pick_spanish_and_back(client, test_store_id):
    token = login_admin(client, test_store_id)
    resp = client.put(
        "/api/v2/auth/profile", json={"language": "es"}, headers=_hdr(token),
    )
    assert resp.status_code == 200
    assert resp.get_json()["language"] == "es"
    with db_session():
        assert _user("admin@test.com").language == "es"
    resp = client.put(
        "/api/v2/auth/profile", json={"language": "en"}, headers=_hdr(token),
    )
    assert resp.get_json()["language"] == "en"


def test_employee_can_pick_spanish_for_themselves_only(test_store_id):
    c, jwt = make_employee_client(test_store_id)
    resp = c.put(
        "/api/v2/auth/profile", json={"language": "es"}, headers=_hdr(jwt),
    )
    assert resp.status_code == 200
    assert resp.get_json()["language"] == "es"
    with db_session():
        # The admin's row is untouched by the employee's choice.
        assert _user("admin@test.com").language is None


def test_saving_other_fields_leaves_language_alone(client, test_store_id):
    token = login_admin(client, test_store_id)
    client.put(
        "/api/v2/auth/profile", json={"language": "es"}, headers=_hdr(token),
    )
    resp = client.put(
        "/api/v2/auth/profile", json={"theme_preference": "light"},
        headers=_hdr(token),
    )
    assert resp.get_json()["language"] == "es"


def test_unknown_language_is_refused(client, test_store_id):
    token = login_admin(client, test_store_id)
    resp = client.put(
        "/api/v2/auth/profile", json={"language": "fr"}, headers=_hdr(token),
    )
    assert resp.status_code == 422
    with db_session():
        assert _user("admin@test.com").language is None


def test_language_save_requires_sign_in(client):
    resp = client.put("/api/v2/auth/profile", json={"language": "es"})
    assert resp.status_code == 401


def test_service_refuses_unknown_language_without_writing():
    import pytest
    from api.Modules.Auth.Services.profile import (
        ProfileValidationError, update_profile,
    )
    with db_session():
        u = _user("admin@test.com")
        with pytest.raises(ProfileValidationError) as exc:
            update_profile(db.session, u, language="de")
        assert "language" in exc.value.field_errors
        assert u.language is None


def test_data_export_includes_language(client, test_store_id):
    token = login_admin(client, test_store_id)
    client.put(
        "/api/v2/auth/profile", json={"language": "es"}, headers=_hdr(token),
    )
    resp = client.get("/api/v2/auth/account/export", headers=_hdr(token))
    assert resp.status_code == 200
    assert '"language": "es"' in resp.get_data(as_text=True)


_MIGRATION = (
    pathlib.Path(__file__).resolve().parents[3]
    / "alembic" / "versions" / "c4a9e2f7b1d5_add_user_language.py"
)


def test_migration_matches_model_and_imports_no_app_code():
    import importlib.util
    from api.Modules.Tenancy.Models import User
    src = _MIGRATION.read_text()
    assert "from api" not in src and "import api" not in src
    spec = importlib.util.spec_from_file_location("_mig", _MIGRATION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    col = User.__table__.c[mod.COLUMN]
    assert col.nullable is True
    assert col.type.length == mod.LENGTH

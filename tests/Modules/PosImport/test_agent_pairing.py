"""Connect codes: DineroBook Manager gets a store's agent key without a
password (owner, 2026-11-19: nobody at the store types an id, a name or
a password).

The invariants under test:

  * only a signed-in person with ``day_close.update`` makes a code;
    an employee without it is refused; making one is audited;
  * the code is stored as sha256 only, lasts 10 minutes and works once,
    even read with lower case, spaces or no dashes;
  * a newer code ends the store's earlier unused one;
  * the key it gives back uploads, and the computer's previous key
    (``X-Agent-Key``) is revoked only when it is the same store's;
  * a closed store gets its gate's answer and no key, and the code
    still works once the store is open;
  * a wrong, used or expired code is one opaque 401;
  * the migration spells out exactly the model's columns, imports no
    application code, and runs up and down twice.
"""
import hashlib
import importlib.util
import re
from datetime import timedelta
from pathlib import Path

from api.Core.Clock import utc_now
from api.Modules.Audit.Models import OperatorAuditLog
from api.Modules.PosImport.Models import PosAgentCredential, PosAgentPairing
from tests._app import db, db_session
from tests.Modules.Auth.test_employee_login import _make_store
from tests.Modules.PosImport.test_agent import _admin, _agent_upload, _issue_key
from tests.Modules.PosImport.test_agent_store_gates import _update_store
from tests.Modules.PosImport.test_naxml import _sale
from tests.conftest import _starlette_client, make_employee_client

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "alembic" / "versions" / "e2f8a4c6b1d3_add_pos_agent_pairing.py"
CODE = re.compile(r"^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$")


def _make_code(client, h):
    resp = client.post("/api/v2/posimport/agent-pairing", headers=h)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _pair(client, code, label="BACKOFFICE – DineroBook Processor", old_key=None):
    # The Manager sends no sign-in: only the code (and its old key).
    _starlette_client.cookies.clear()
    headers = {"X-Agent-Key": old_key} if old_key else {}
    return client.post(
        "/api/v2/posimport/agent/pair", headers=headers,
        json={"code": code, "label": label},
    )


def _expire(code):
    raw = re.sub(r"[^A-Z0-9]", "", code.upper())
    with db_session():
        row = db.session.query(PosAgentPairing).filter_by(
            code_hash=hashlib.sha256(raw.encode()).hexdigest(),
        ).one()
        row.expires_at = utc_now() - timedelta(seconds=1)
        db.session.commit()


def test_a_code_gives_a_working_key_and_is_audited(client, test_store_id):
    h = _admin(client, test_store_id)
    made = _make_code(client, h)
    assert CODE.match(made["code"]), made
    assert made["minutes"] == 10

    resp = _pair(client, made["code"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["key"].startswith("pak_")
    assert body["store_id"] == test_store_id
    assert body["store_name"]
    assert body["connected_by"]
    assert body["label"] == "BACKOFFICE – DineroBook Processor"

    up = _agent_upload(client, body["key"], "PJR1.xml", _sale())
    assert up.status_code == 200, up.text

    with db_session():
        rows = db.session.query(PosAgentPairing).filter_by(store_id=test_store_id).all()
        assert len(rows) == 1
        # Only the hash is stored; the row names the key it became.
        assert made["code"].replace("-", "") not in rows[0].code_hash
        assert rows[0].used_at is not None
        assert rows[0].credential_id == body["id"]
        actions = {
            a.action for a in db.session.query(OperatorAuditLog).filter_by(store_id=test_store_id)
        }
        assert {"issue_pos_agent_pairing", "issue_pos_agent_key"} <= actions


def test_a_code_works_once(client, test_store_id):
    code = _make_code(client, _admin(client, test_store_id))["code"]
    assert _pair(client, code).status_code == 200
    again = _pair(client, code)
    assert again.status_code == 401
    assert "connect code does not work" in again.json()["detail"]


def test_lower_case_spaces_and_missing_dashes_still_read(client, test_store_id):
    code = _make_code(client, _admin(client, test_store_id))["code"]
    typed = " " + code.lower().replace("-", " ") + " "
    assert _pair(client, typed).status_code == 200


def test_an_expired_code_is_refused(client, test_store_id):
    code = _make_code(client, _admin(client, test_store_id))["code"]
    _expire(code)
    assert _pair(client, code).status_code == 401


def test_a_newer_code_ends_the_earlier_one(client, test_store_id):
    h = _admin(client, test_store_id)
    first = _make_code(client, h)["code"]
    second = _make_code(client, h)["code"]
    assert _pair(client, first).status_code == 401
    assert _pair(client, second).status_code == 200


def test_wrong_codes_get_one_opaque_answer(client):
    for code in ("ZZZZ-ZZZZ-ZZZZ", "short", "!!!!"):
        resp = _pair(client, code)
        assert resp.status_code == 401, (code, resp.text)


def test_the_previous_key_of_the_same_store_is_revoked(client, test_store_id):
    h = _admin(client, test_store_id)
    old = _issue_key(client, h)["key"]
    code = _make_code(client, h)["code"]
    new = _pair(client, code, old_key=old).json()["key"]
    assert _agent_upload(client, old, "PJR1.xml", _sale()).status_code == 401
    assert _agent_upload(client, new, "PJR1.xml", _sale()).status_code == 200


def test_another_stores_key_is_never_revoked(client, test_store_id):
    from api.Modules.PosImport.Services import issue_agent_key
    with db_session():
        other = _make_store("pair-other", "Pair Other")
        _, other_key = issue_agent_key(db.session, other, label="Other PC")
        db.session.commit()
    code = _make_code(client, _admin(client, test_store_id))["code"]
    assert _pair(client, code, old_key=other_key).status_code == 200
    with db_session():
        cred = db.session.query(PosAgentCredential).filter_by(store_id=other).one()
        assert cred.revoked_at is None


def test_a_closed_store_gets_no_key_until_it_opens(client, test_store_id):
    code = _make_code(client, _admin(client, test_store_id))["code"]
    _update_store(test_store_id, is_active=False)
    resp = _pair(client, code)
    assert resp.status_code == 403, resp.text
    assert resp.json()["reason"] == "store_disabled"
    with db_session():
        assert db.session.query(PosAgentCredential).filter_by(store_id=test_store_id).count() == 0
    _update_store(test_store_id, is_active=True)
    assert _pair(client, code).status_code == 200


def test_an_employee_without_day_close_edit_cannot_make_a_code(client, test_store_id):
    _, jwt = make_employee_client(test_store_id)
    resp = client.post(
        "/api/v2/posimport/agent-pairing", headers={"Authorization": f"Bearer {jwt}"},
    )
    assert resp.status_code == 403


# ── The migration ──


def _load():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_imports_no_application_code():
    for line in MIGRATION.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


def test_migration_matches_the_model_and_runs_up_and_down_twice(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    m = _load()
    url = f"sqlite:///{tmp_path / 'pair.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def tables():
        return set(inspect(engine).get_table_names())

    command.upgrade(cfg, m.down_revision)
    assert m.TABLE not in tables()
    command.upgrade(cfg, m.revision)
    command.upgrade(cfg, m.revision)
    cols = {c["name"]: c for c in inspect(engine).get_columns(m.TABLE)}
    model = PosAgentPairing.__table__.columns
    assert set(cols) == {c.name for c in model}
    for c in model:
        assert cols[c.name]["nullable"] == c.nullable, c.name
        assert type(cols[c.name]["type"]).__name__.upper() == type(c.type).__name__.upper() or (
            c.type.compile() == cols[c.name]["type"].compile()
        ), c.name
    uniques = inspect(engine).get_unique_constraints(m.TABLE)
    assert [u["column_names"] for u in uniques] == [["code_hash"]]

    command.downgrade(cfg, m.down_revision)
    command.downgrade(cfg, m.down_revision)
    assert m.TABLE not in tables()
    command.upgrade(cfg, m.revision)
    assert m.TABLE in tables()

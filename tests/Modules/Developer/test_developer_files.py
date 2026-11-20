"""The store's Developer tab: its register's files, for a superadmin
signed in AS the store (owner, 2026-11-20).

Only an impersonation token whose superadmin is still active gets
in — the store's own admin and employees never do, whatever they
are granted. The store is the token's own; a file of another store
is a 404. Every route is a GET, so a read-only impersonation works.
The raw file is only ever plain text in the browser.

Fixtures are SYNTHETIC — no store data in the repo.
"""
import pytest

from api.Core.Clock import utc_now
from api.Modules.PosImport.Services import stage_journal_file
from tests._app import db, db_session
from tests.conftest import login_admin, login_employee, login_superadmin
from tests.Modules.PosImport.movement_fixtures import fgm
from tests.Modules.PosImport.test_naxml import _sale

NOT_XML = b"this is not xml at all"
PRICE_BOOK = (
    b'<?xml version="1.0" encoding="ISO-8859-1"?>'
    b"<NAXML-MaintenanceRequest><ItemMaintenance/></NAXML-MaintenanceRequest>"
)


def _stage(store_id, name, content):
    with db_session():
        result = stage_journal_file(
            db.session, store_id, filename=name,
            content=content if isinstance(content, bytes)
            else content.encode("ISO-8859-1"),
        )
        db.session.commit()
        return int(result.file.id)


def _new_store(slug):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        s = Store(name=f"Store {slug}", slug=slug, email=f"{slug}@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.commit()
        return int(s.id)


def _mk_user(store_id, role="admin"):
    from api.Modules.Tenancy.Models import User
    stamp = utc_now().timestamp()
    with db_session():
        u = User(username=f"dev-{role}-{store_id}-{stamp}@test.com",
                 role=role, full_name="Dev Target", store_id=store_id,
                 is_active=True)
        u.set_password("targetpass123!")
        db.session.add(u)
        db.session.commit()
        return int(u.id), u.username


def _impersonate(client, store_id, mode="full", role="admin"):
    sa = {"Authorization": f"Bearer {login_superadmin(client)}"}
    uid, _ = _mk_user(store_id, role)
    resp = client.post(
        f"/api/v2/superadmin/impersonate/{uid}", headers=sa,
        json={"mode": mode},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['token']}"}


@pytest.fixture
def files(test_store_id):
    """One of each: a sale, a movement report, a price book the
    readers don't take, and a file that is not XML."""
    stamp = int(utc_now().timestamp() * 1000)
    return {
        "sale": _stage(test_store_id, f"PJR-dev-sale-{stamp}.xml",
                       _sale(business_date="2025-03-04")),
        "movement": _stage(test_store_id, f"FGM-dev-{stamp}.xml",
                           fgm(business_date="2025-03-05")),
        "pricebook": _stage(test_store_id, f"ITM-dev-{stamp}.xml", PRICE_BOOK),
        "broken": _stage(test_store_id, f"PJR-dev-broken-{stamp}.xml", NOT_XML),
    }


# ── Who gets in ────────────────────────────────────────────


@pytest.mark.parametrize("path", [
    "/api/v2/developer/files",
    "/api/v2/developer/files/1",
    "/api/v2/developer/files/1/raw",
])
def test_the_store_admin_is_refused(client, test_store_id, path):
    token = login_admin(client, test_store_id)
    resp = client.get(path, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    assert "superadmin" in resp.json()["detail"]


def test_an_employee_is_refused(client, test_store_id):
    _, username = _mk_user(test_store_id, role="employee")
    token = login_employee(client, test_store_id, username, "targetpass123!")
    resp = client.get(
        "/api/v2/developer/files",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_a_stranger_is_refused(client):
    assert client.get("/api/v2/developer/files").status_code == 401


@pytest.mark.parametrize("mode", ["full", "read_only"])
def test_a_superadmin_signed_in_as_the_store_gets_in(
    client, test_store_id, files, mode,
):
    headers = _impersonate(client, test_store_id, mode=mode)
    resp = client.get("/api/v2/developer/files", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["store_id"] == test_store_id
    assert body["store_name"]
    ids = {r["id"] for r in body["rows"]}
    assert set(files.values()) <= ids


def test_a_deactivated_superadmin_loses_it_at_once(
    client, test_store_id, files,
):
    from api.Modules.Tenancy.Models import User
    headers = _impersonate(client, test_store_id)
    with db_session():
        sa = db.session.query(User).filter_by(role="superadmin").first()
        sa.is_active = False
        db.session.commit()
    try:
        resp = client.get("/api/v2/developer/files", headers=headers)
        assert resp.status_code == 403
    finally:
        with db_session():
            sa = db.session.query(User).filter_by(role="superadmin").first()
            sa.is_active = True
            db.session.commit()


def test_another_stores_file_is_not_found(client, test_store_id):
    other = _new_store(f"dev-other-{int(utc_now().timestamp() * 1000)}")
    fid = _stage(other, "PJR-other.xml", _sale())
    headers = _impersonate(client, test_store_id)
    for suffix in ("", "/raw"):
        resp = client.get(f"/api/v2/developer/files/{fid}{suffix}", headers=headers)
        assert resp.status_code == 404, suffix
    rows = client.get("/api/v2/developer/files", headers=headers).json()["rows"]
    assert fid not in {r["id"] for r in rows}


# ── The list ───────────────────────────────────────────────


def _list(client, headers, **params):
    resp = client.get(
        "/api/v2/developer/files", headers=headers, query_string=params,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_each_file_says_what_it_is_and_whether_it_imported(
    client, test_store_id, files,
):
    headers = _impersonate(client, test_store_id)
    rows = {r["id"]: r for r in _list(client, headers, per_page=200)["rows"]}
    sale, movement = rows[files["sale"]], rows[files["movement"]]
    pricebook, broken = rows[files["pricebook"]], rows[files["broken"]]
    assert (sale["kind"], sale["event_kind"], sale["imported"]) == (
        "journal", "sale", True,
    )
    assert sale["business_date"] == "2025-03-04" and sale["reason"] == ""
    assert (movement["kind"], movement["imported"]) == ("movement", True)
    assert (pricebook["kind"], pricebook["imported"]) == ("unknown", False)
    assert "POSJournal" in pricebook["reason"]
    assert (broken["kind"], broken["imported"]) == ("unknown", False)
    assert broken["reason"] == "Not well-formed XML."
    assert sale["received_at"]


def test_filters_narrow_the_list(client, test_store_id, files):
    headers = _impersonate(client, test_store_id)
    not_imported = {r["id"] for r in _list(
        client, headers, status="not_imported", per_page=200,
    )["rows"]}
    assert {files["pricebook"], files["broken"]} <= not_imported
    assert files["sale"] not in not_imported

    imported = {r["id"] for r in _list(
        client, headers, status="imported", per_page=200,
    )["rows"]}
    assert {files["sale"], files["movement"]} <= imported
    assert files["broken"] not in imported

    movements = _list(client, headers, kind="movement", per_page=200)["rows"]
    assert files["movement"] in {r["id"] for r in movements}
    assert all(r["kind"] == "movement" for r in movements)

    found = _list(client, headers, q="well-formed")["rows"]
    assert [r["id"] for r in found] == [files["broken"]]

    day = _list(client, headers, start="2025-03-04", end="2025-03-04",
                per_page=200)["rows"]
    assert files["sale"] in {r["id"] for r in day}
    assert files["movement"] not in {r["id"] for r in day}


def test_the_summary_counts_the_whole_store(client, test_store_id, files):
    headers = _impersonate(client, test_store_id)
    filtered = _list(client, headers, kind="movement")
    assert filtered["summary"]["files"] >= 4
    assert filtered["summary"]["not_imported"] >= 2
    assert filtered["summary"]["last_received_at"]


def test_sort_by_file_name(client, test_store_id, files):
    headers = _impersonate(client, test_store_id)
    names = [r["filename"] for r in _list(
        client, headers, sort="filename", direction="asc", per_page=200,
    )["rows"]]
    assert names == sorted(names)


@pytest.mark.parametrize("params", [
    {"status": "lost"}, {"kind": "pdf"}, {"sort": "size"},
    {"direction": "up"}, {"start": "2025-03-05", "end": "2025-03-04"},
    {"start": "yesterday"},
])
def test_unknown_filters_are_refused(client, test_store_id, params):
    headers = _impersonate(client, test_store_id)
    resp = client.get("/api/v2/developer/files", headers=headers, query_string=params)
    assert resp.status_code == 422


# ── One file ───────────────────────────────────────────────


def test_detail_carries_the_xml_as_written(client, test_store_id, files):
    headers = _impersonate(client, test_store_id, mode="read_only")
    resp = client.get(
        f"/api/v2/developer/files/{files['sale']}", headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["file"]["id"] == files["sale"]
    assert body["encoding"] == "iso8859-1"
    assert body["xml"].startswith("<?xml")
    assert "<SaleEvent>" in body["xml"]
    assert body["truncated"] is False
    assert body["size_bytes"] == len(_sale(business_date="2025-03-04").encode("ISO-8859-1"))
    assert body["line_count"] >= 1


def test_detail_cuts_a_huge_file_but_says_so(
    client, test_store_id, files, monkeypatch,
):
    import api.Modules.Developer.Services as svc
    monkeypatch.setattr(svc, "SHOW_LIMIT_BYTES", 40)
    headers = _impersonate(client, test_store_id)
    body = client.get(
        f"/api/v2/developer/files/{files['sale']}", headers=headers,
    ).json()
    assert body["truncated"] is True
    assert len(body["xml"]) == 40


def test_a_file_without_a_declaration_reads_as_utf8(client, test_store_id, files):
    headers = _impersonate(client, test_store_id)
    body = client.get(
        f"/api/v2/developer/files/{files['broken']}", headers=headers,
    ).json()
    assert body["encoding"] == "utf-8"
    assert body["xml"] == NOT_XML.decode()


def test_raw_is_plain_text_never_xml(client, test_store_id, files):
    headers = _impersonate(client, test_store_id, mode="read_only")
    resp = client.get(
        f"/api/v2/developer/files/{files['sale']}/raw", headers=headers,
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.headers["x-content-type-options"] == "nosniff"
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["content-disposition"].startswith("inline;")
    assert "<SaleEvent>" in resp.text


def test_download_sends_the_exact_bytes(client, test_store_id, files):
    headers = _impersonate(client, test_store_id)
    resp = client.get(
        f"/api/v2/developer/files/{files['pricebook']}/raw",
        headers=headers, query_string={"download": "1"},
    )
    assert resp.status_code == 200
    assert resp.content == PRICE_BOOK
    assert resp.headers["content-type"] == "application/octet-stream"
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert ".xml" in disposition


def test_header_file_names_are_cleaned():
    from api.Modules.Developer.Services import safe_filename
    assert safe_filename('a"b\r\nc.xml') == "a_b__c.xml"
    assert safe_filename("../..") == "file"

"""Check cashing PR 3: pictures —
api/Modules/CheckCashing/INVARIANTS.md ("Pictures").

The rules under test:
  * every picture is re-encoded: JPEG, upright, no metadata, at most
    MAX_SIDE pixels; anything that is not a JPEG / PNG / WebP picture,
    an oversized one or bad base64 is refused;
  * a check picture is saved first and joins its check on save (one of
    each side, this store's, not on another check); leftovers go after
    a day;
  * an ID picture belongs to one of the customer's IDs, the photo to
    the customer; a new one replaces the old (kept as history); removing
    an ID removes its pictures;
  * rights: check pictures need create, profile pictures update, looking
    needs read; the owner's stores see them, unrelated stores do not;
    the computer lock and the module switch apply; the accountant and a
    stranger are refused;
  * profile pictures are audited; check pictures show in the check's
    audit summary; pictures purge with the store and follow a customer
    who moves to a sibling store.
"""
import base64
import io
from datetime import timedelta

import pytest
from PIL import Image

from tests._app import db, db_session
from tests.conftest import login_admin, login_employee
from tests.Modules.CheckCashing.test_cash_a_check import _cash, _settings
from tests.Modules.CheckCashing.test_check_cashing import (  # noqa: F401
    BASE, _activate, _audit_actions, _employee, _flag, _h, _link_owner,
    _mk_company, _mk_customer, _new_store, admin, cashier, on,
)

PICS = f"{BASE}/pictures"
READ_ONLY = {"check_cashing": {"read": True}}
CREATE_ONLY = {"check_cashing": {"read": True, "create": True}}


def _image(fmt="JPEG", size=(1200, 520), color=(200, 220, 240), exif=False):
    img = Image.new("RGB", size, color)
    out = io.BytesIO()
    kwargs = {}
    if exif:
        ex = Image.Exif()
        ex[0x010F] = "SecretCam"      # Make
        ex[0x0112] = 6                # Orientation: rotate 90° on show
        kwargs["exif"] = ex.tobytes()
    img.save(out, format=fmt, **kwargs)
    return base64.b64encode(out.getvalue()).decode()


def _post(client, h, kind, content=None, **over):
    body = {"kind": kind, "content_base64": content or _image(), **over}
    return client.post(PICS, headers=h, json=body)


def _pic(client, h, kind="check_front", **over):
    resp = _post(client, h, kind, **over)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _bytes(client, h, pid):
    resp = client.get(f"{PICS}/{pid}", headers=h)
    assert resp.status_code == 200, resp.text
    return resp


@pytest.fixture
def party(client, admin):
    _settings(client, admin)
    return _mk_customer(client, admin), _mk_company(client, admin)


class TestCleaning:
    def test_saved_as_a_clean_jpeg(self, client, admin):
        out = _pic(client, admin, content=_image("PNG", size=(3000, 1300)))
        assert out["kind"] == "check_front"
        assert max(out["width"], out["height"]) == 1600
        resp = _bytes(client, admin, out["id"])
        assert resp.headers["content-type"] == "image/jpeg"
        assert resp.headers["cache-control"] == "no-store"
        img = Image.open(io.BytesIO(resp.content))
        assert img.format == "JPEG"
        assert len(resp.content) == out["size_bytes"]

    def test_metadata_is_stripped_and_turned_upright(self, client, admin):
        out = _pic(client, admin, content=_image(size=(800, 400), exif=True))
        # Orientation 6 means "turn 90°": the stored picture is upright.
        assert (out["width"], out["height"]) == (400, 800)
        img = Image.open(io.BytesIO(_bytes(client, admin, out["id"]).content))
        assert not img.getexif()
        assert b"SecretCam" not in _bytes(client, admin, out["id"]).content

    def test_webp_is_accepted(self, client, admin):
        assert _pic(client, admin, content=_image("WEBP"))["width"] == 1200

    @pytest.mark.parametrize("content", [
        base64.b64encode(b"%PDF-1.7 not a picture").decode(),
        base64.b64encode(b"GIF89a" + b"\0" * 40).decode(),
        "",
    ])
    def test_refuses_what_is_not_a_picture(self, client, admin, content):
        resp = _post(client, admin, "check_front", content=content or "AAAA")
        assert resp.status_code in (409, 422), resp.text

    def test_refuses_a_gif(self, client, admin):
        resp = _post(client, admin, "check_front", content=_image("GIF"))
        assert resp.status_code == 409
        assert "JPEG, PNG or WebP" in resp.json()["detail"]

    def test_refuses_bad_base64(self, client, admin):
        resp = _post(client, admin, "check_front", content="not base64!!")
        assert resp.status_code == 422

    def test_accepts_a_data_url(self, client, admin):
        assert _pic(client, admin, content="data:image/jpeg;base64," + _image())

    def test_refuses_too_many_pixels(self, client, admin, monkeypatch):
        from api.Modules.CheckCashing.Services import pictures
        monkeypatch.setattr(pictures, "MAX_PIXELS", 1000)
        resp = _post(client, admin, "check_front")
        assert resp.status_code == 409
        assert "too large" in resp.json()["detail"]

    def test_refuses_too_many_bytes(self, client, admin, monkeypatch):
        from api.Modules.CheckCashing.Services import pictures
        monkeypatch.setattr(pictures, "MAX_UPLOAD_BYTES", 100)
        resp = _post(client, admin, "check_front")
        assert resp.status_code == 409
        assert "8 MB" in resp.json()["detail"]

    @pytest.mark.parametrize("body", [
        {"kind": "id_front", "customer_id": 1},
        {"kind": "photo"},
        {"kind": "photo", "customer_id": 1, "id_row_id": 1},
        {"kind": "check_back", "customer_id": 1},
        {"kind": "selfie", "customer_id": 1},
    ])
    def test_owner_must_match_the_kind(self, client, admin, body):
        resp = client.post(PICS, headers=admin,
                           json={"content_base64": _image(), **body})
        assert resp.status_code == 422


class TestCheckPictures:
    def test_join_the_check_and_show_on_its_row(self, client, admin, on, party):
        cust, comp = party
        front = _pic(client, admin, "check_front")
        back = _pic(client, admin, "check_back")
        resp = _cash(client, admin, cust, comp,
                     picture_ids=[front["id"], back["id"]])
        assert resp.status_code == 201, resp.text
        row = resp.json()["check"]
        assert (row["front_picture_id"], row["back_picture_id"]) == (
            front["id"], back["id"])
        act = client.get(f"{BASE}/customers/{cust['id']}/activity",
                         headers=admin).json()
        assert act["recent"][0]["front_picture_id"] == front["id"]
        from api.Modules.Audit.Models import OperatorAuditLog
        with db_session():
            last = db.session.query(OperatorAuditLog).order_by(
                OperatorAuditLog.id.desc()).first()
            assert last.action == "cash_check"
            assert last.summary.endswith("2 pictures")

    def test_a_declined_check_keeps_its_picture(self, client, admin, party):
        cust, comp = party
        front = _pic(client, admin)
        row = _cash(client, admin, cust, comp, decision="decline",
                    reason="Altered amount", picture_ids=[front["id"]]).json()["check"]
        assert row["status"] == "declined"
        assert row["front_picture_id"] == front["id"]

    def test_a_picture_joins_only_one_check(self, client, admin, party):
        cust, comp = party
        front = _pic(client, admin)
        assert _cash(client, admin, cust, comp,
                     picture_ids=[front["id"]]).status_code == 201
        resp = _cash(client, admin, cust, comp, check_number="2",
                     ack=["cashed_today"], picture_ids=[front["id"]])
        assert resp.status_code == 409
        assert "Take the picture again" in resp.json()["detail"]

    def test_one_of_each_side(self, client, admin, party):
        cust, comp = party
        a, b = _pic(client, admin), _pic(client, admin)
        resp = _cash(client, admin, cust, comp, picture_ids=[a["id"], b["id"]])
        assert resp.status_code == 409
        # Nothing was saved: the check is not there.
        assert client.get(f"{BASE}/checks", headers=admin).json()["total"] == 0

    def test_not_a_profile_picture_or_unknown_id(self, client, admin, party):
        cust, comp = party
        photo = _pic(client, admin, "photo", customer_id=cust["id"])
        for ids in ([photo["id"]], [999_999]):
            resp = _cash(client, admin, cust, comp, picture_ids=ids)
            assert resp.status_code == 409, ids

    def test_not_another_stores_picture(self, client, admin, on, party):
        cust, comp = party
        front = _pic(client, admin)
        sibling = _new_store("cc-pic-sib1")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        assert _cash(client, h, cust, comp, picture_ids=[front["id"]]).status_code == 409

    def test_leftovers_go_after_a_day(self, client, admin, on, party):
        from api.Core.Clock import utc_now
        from api.Modules.CheckCashing.Models import CheckPicture
        cust, comp = party
        old = _pic(client, admin)
        used = _pic(client, admin)
        _cash(client, admin, cust, comp, picture_ids=[used["id"]])
        with db_session():
            for pid in (old["id"], used["id"]):
                db.session.get(CheckPicture, pid).created_at = (
                    utc_now() - timedelta(days=2))
            db.session.commit()
        _pic(client, admin)
        with db_session():
            assert db.session.get(CheckPicture, old["id"]) is None
            assert db.session.get(CheckPicture, used["id"]) is not None


class TestCustomerPictures:
    def test_id_pictures_and_photo_on_the_profile(self, client, admin, on, party):
        cust, _ = party
        id_row = cust["ids"][0]["id"]
        front = _pic(client, admin, "id_front", customer_id=cust["id"],
                     id_row_id=id_row)
        back = _pic(client, admin, "id_back", customer_id=cust["id"],
                    id_row_id=id_row)
        photo = _pic(client, admin, "photo", customer_id=cust["id"])
        detail = client.get(f"{BASE}/customers/{cust['id']}",
                            headers=admin).json()["customer"]
        assert detail["photo_picture_id"] == photo["id"]
        assert (detail["ids"][0]["front_picture_id"],
                detail["ids"][0]["back_picture_id"]) == (front["id"], back["id"])
        assert _audit_actions(on)[-3:] == ["add_check_customer_picture"] * 3
        from api.Modules.Audit.Models import OperatorAuditLog
        with db_session():
            rows = db.session.query(OperatorAuditLog).filter_by(
                action="add_check_customer_picture").order_by(OperatorAuditLog.id).all()
            assert rows[0].summary == "front of ID drivers_license ••••4567"
            assert "D1234567" not in rows[0].summary

    def test_a_new_picture_replaces_the_old_one(self, client, admin, party):
        from api.Modules.CheckCashing.Models import CheckPicture
        cust, _ = party
        first = _pic(client, admin, "photo", customer_id=cust["id"])
        second = _pic(client, admin, "photo", customer_id=cust["id"])
        detail = client.get(f"{BASE}/customers/{cust['id']}",
                            headers=admin).json()["customer"]
        assert detail["photo_picture_id"] == second["id"]
        with db_session():
            assert db.session.get(CheckPicture, first["id"]).replaced_at is not None
        # The old one is history: still there to look at.
        _bytes(client, admin, first["id"])

    def test_another_customers_id_is_not_found(self, client, admin, party):
        cust, _ = party
        other = _mk_customer(client, admin, "Other Person")
        resp = _post(client, admin, "id_front", customer_id=cust["id"],
                     id_row_id=other["ids"][0]["id"])
        assert resp.status_code == 404
        resp = _post(client, admin, "photo", customer_id=999_999)
        assert resp.status_code == 404

    def test_removing_an_id_removes_its_pictures(self, client, admin, party):
        from api.Modules.CheckCashing.Models import CheckPicture
        cust, _ = party
        added = client.post(f"{BASE}/customers/{cust['id']}/ids", headers=admin, json={
            "id_type": "passport", "id_number": "P7654321", "issuer": "Mexico",
        }).json()["customer"]["ids"][-1]
        pic = _pic(client, admin, "id_front", customer_id=cust["id"],
                   id_row_id=added["id"])
        resp = client.delete(f"{BASE}/customers/{cust['id']}/ids/{added['id']}",
                             headers=admin)
        assert resp.status_code == 200, resp.text
        with db_session():
            assert db.session.get(CheckPicture, pic["id"]) is None


class TestRights:
    def test_cashier_adds_check_and_profile_pictures(self, client, cashier, party):
        cust, _ = party
        assert _post(client, cashier, "check_front").status_code == 201
        assert _post(client, cashier, "photo", customer_id=cust["id"]).status_code == 201

    def test_create_only_cannot_change_a_profile(self, client, admin, on, party):
        cust, _ = party
        h, _uid = _employee(client, on, "cc_pic_create", CREATE_ONLY)
        assert _post(client, h, "check_front").status_code == 201
        assert _post(client, h, "photo", customer_id=cust["id"]).status_code == 403

    def test_read_only_looks_but_cannot_add(self, client, admin, on, party):
        cust, _ = party
        pid = _pic(client, admin)["id"]
        h, _uid = _employee(client, on, "cc_pic_read", READ_ONLY)
        assert _post(client, h, "check_front").status_code == 403
        assert _post(client, h, "photo", customer_id=cust["id"]).status_code == 403
        assert client.get(f"{PICS}/{pid}", headers=h).status_code == 200

    def test_no_rights_refused(self, client, admin, on):
        pid = _pic(client, admin)["id"]
        h, _uid = _employee(client, on, "cc_pic_none", {"time_clock": {"read": True}})
        assert _post(client, h, "check_front").status_code == 403
        assert client.get(f"{PICS}/{pid}", headers=h).status_code == 403

    def test_accountant_refused(self, client, admin, on):
        from api.Modules.Tenancy.Models import User
        pid = _pic(client, admin)["id"]
        with db_session():
            u = User(store_id=on, username="cc-pic-acct@x.com",
                     full_name="Acct", role="accountant")
            u.set_password("acctpass1234")
            db.session.add(u)
            db.session.commit()
        h = _h(login_employee(client, on, "cc-pic-acct@x.com", "acctpass1234"))
        assert _post(client, h, "check_front").status_code == 403
        assert client.get(f"{PICS}/{pid}", headers=h).status_code == 403

    def test_signed_out_refused(self, client, admin):
        pid = _pic(client, admin)["id"]
        from tests.conftest import _starlette_client
        _starlette_client.cookies.clear()
        assert client.post(PICS, json={"kind": "check_front",
                                       "content_base64": _image()}).status_code == 401
        assert client.get(f"{PICS}/{pid}").status_code == 401

    def test_another_computer_is_locked_out(self, client, admin, on):
        pid = _pic(client, admin)["id"]
        from tests.conftest import _starlette_client
        _starlette_client.cookies.clear()
        h = _h(login_admin(client, on))
        assert _post(client, h, "check_front").status_code == 403
        assert client.get(f"{PICS}/{pid}", headers=h).status_code == 403

    def test_module_off_refused(self, client, admin, on):
        pid = _pic(client, admin)["id"]
        _flag(on, False)
        resp = client.get(f"{PICS}/{pid}", headers=admin)
        assert resp.status_code == 403
        assert "not turned on" in resp.json()["detail"]

    def test_owner_stores_see_unrelated_do_not(self, client, admin, on, party):
        cust, _ = party
        pid = _pic(client, admin, "photo", customer_id=cust["id"])["id"]
        sibling = _new_store("cc-pic-sib2")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        assert client.get(f"{PICS}/{pid}", headers=h).status_code == 200
        other = _new_store("cc-pic-other")
        _flag(other, True)
        h2 = _h(login_admin(client, other))
        _activate(client, h2)
        assert client.get(f"{PICS}/{pid}", headers=h2).status_code == 404
        assert _post(client, h2, "photo", customer_id=cust["id"]).status_code == 404

    def test_missing_picture_404(self, client, admin):
        assert client.get(f"{PICS}/999999", headers=admin).status_code == 404


class TestPurge:
    def test_pictures_purge_first(self):
        from api.Modules.Billing.Services.retention import _store_owned_models
        from api.Modules.CheckCashing.Models import (
            CashedCheck, CheckCustomer, CheckCustomerId, CheckPicture,
        )
        pairs = _store_owned_models()
        i = pairs.index((CheckPicture, "store_id"))
        for model in (CashedCheck, CheckCustomerId, CheckCustomer):
            assert i < pairs.index((model, "store_id"))

    def test_pictures_follow_a_rehomed_customer(self, client, admin, on, party):
        """A added the customer and took their photo; sibling B cashed
        a check (with a picture) and took a picture of an ID of a
        customer only A had. Purging A: the moved customer keeps the
        photo at B, B's check keeps its picture, and B's picture of the
        deleted customer goes with them."""
        from api.Core.Clock import utc_now
        from api.Modules.Billing.Services.retention import purge_expired_stores
        from api.Modules.CheckCashing.Models import CheckPicture
        from api.Modules.Tenancy.Models import Store
        cust, comp = party
        alone = _mk_customer(client, admin, "Only Here")
        photo = _pic(client, admin, "photo", customer_id=cust["id"])
        a_check = _pic(client, admin)
        _cash(client, admin, alone, comp, check_number="5",
              picture_ids=[a_check["id"]])
        sibling = _new_store("cc-pic-purge")
        _flag(sibling, True)
        _link_owner(on, sibling)
        h = _h(login_admin(client, sibling))
        _activate(client, h)
        b_check = _pic(client, h)
        _cash(client, h, cust, comp, check_number="9", picture_ids=[b_check["id"]])
        b_of_alone = _pic(client, h, "id_front", customer_id=alone["id"],
                          id_row_id=alone["ids"][0]["id"])
        with db_session():
            store = db.session.get(Store, on)
            store.plan = "inactive"
            store.data_retention_until = utc_now() - timedelta(days=1)
            db.session.commit()
            assert purge_expired_stores(db.session) == 1
            kept = db.session.get(CheckPicture, photo["id"])
            assert kept is not None and kept.store_id == sibling
            assert db.session.get(CheckPicture, b_check["id"]) is not None
            assert db.session.get(CheckPicture, a_check["id"]) is None
            assert db.session.get(CheckPicture, b_of_alone["id"]) is None

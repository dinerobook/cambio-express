"""Lottery: cross-store isolation, input validation, audit trail.

Complements `test_lottery.py` (happy paths + lifecycle guards). The
rules under test:
  * another store's games / packs are 404 (never 403/200, never
    editable) and never appear in lists,
  * bad dates / unknown statuses / out-of-range bodies are 422,
  * every mutating route leaves an `audit_operator_log` row,
  * count validation: past-pack-end, below-previous, above-later,
    and an in-place re-count (upsert) replaces rather than duplicates.
"""
from datetime import date

import pytest

from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _second_store_admin(client):
    """A second store with its own admin; returns (store_id, headers)."""
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Lottery B", slug="lottery-b", email="b@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="admin-b@x.com",
                 full_name="Admin B", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        sid = s.id
    return sid, _h(login_admin(client, sid))


def _mk_game(client, h, number="2417", per_pack=60):
    resp = client.post("/api/v2/lottery/games", headers=h, json={
        "game_number": number, "name": f"Game {number}",
        "ticket_price": 5.0, "tickets_per_pack": per_pack,
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["game"]


def _mk_pack(client, h, game_id, number="0001", activate=True, opening=0):
    resp = client.post("/api/v2/lottery/packs", headers=h, json={
        "game_id": game_id, "pack_number": number,
        "received_on": "2026-08-01",
    })
    assert resp.status_code == 201, resp.text
    pack = resp.json()["pack"]
    if activate:
        resp = client.post(
            f"/api/v2/lottery/packs/{pack['id']}/activate", headers=h,
            json={"activated_on": "2026-08-01", "opening_ticket": opening},
        )
        assert resp.status_code == 200, resp.text
        pack = resp.json()["pack"]
    return pack


def _audit_actions(store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    with db_session():
        return [r.action for r in db.session.query(OperatorAuditLog)
                .filter_by(store_id=store_id).order_by(
                    OperatorAuditLog.id).all()]


# ── cross-store isolation ───────────────────────────────────


def test_other_stores_game_and_pack_are_404(client, test_store_id):
    h_a = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h_a)
    pack = _mk_pack(client, h_a, game["id"])
    _, h_b = _second_store_admin(client)

    assert client.put(
        f"/api/v2/lottery/games/{game['id']}", headers=h_b,
        json={"name": "Hijack"},
    ).status_code == 404
    assert client.post("/api/v2/lottery/packs", headers=h_b, json={
        "game_id": game["id"], "pack_number": "X1",
        "received_on": "2026-08-01",
    }).status_code == 404
    for action, body in (
        ("activate", {"activated_on": "2026-08-01"}),
        ("settle", {"on": "2026-08-02"}),
        ("return", {"on": "2026-08-02"}),
    ):
        resp = client.post(
            f"/api/v2/lottery/packs/{pack['id']}/{action}",
            headers=h_b, json=body,
        )
        assert resp.status_code == 404, (action, resp.text)
    assert client.post(
        "/api/v2/lottery/day/2026-08-02/counts", headers=h_b,
        json={"pack_id": pack["id"], "closing_ticket": 5},
    ).status_code == 404

    # B sees none of A's data, and A's pack is untouched.
    assert client.get("/api/v2/lottery/games?include_inactive=1",
                      headers=h_b).json()["games"] == []
    assert client.get("/api/v2/lottery/packs",
                      headers=h_b).json()["packs"] == []
    assert client.get("/api/v2/lottery/day/2026-08-02",
                      headers=h_b).json()["rows"] == []
    after = client.get("/api/v2/lottery/packs", headers=h_a).json()["packs"]
    assert [(p["status"], p["game_name"]) for p in after] == [
        ("active", "Game 2417")]


def test_same_game_number_allowed_in_different_stores(client, test_store_id):
    h_a = _h(login_admin(client, test_store_id))
    _, h_b = _second_store_admin(client)
    _mk_game(client, h_a, "555")
    _mk_game(client, h_b, "555")


def test_requests_without_token_are_401(client):
    assert client.get("/api/v2/lottery/games").status_code == 401
    assert client.post("/api/v2/lottery/games", json={}).status_code == 401


def test_employee_cannot_manage_games_or_packs(
    client, test_store_id,
):
    h_a = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h_a)
    pack = _mk_pack(client, h_a, game["id"], activate=False)
    _, emp_jwt = make_employee_client(test_store_id)
    h_e = _h(emp_jwt)
    # Mutations on games/packs are admin-only.
    assert client.put(
        f"/api/v2/lottery/games/{game['id']}", headers=h_e,
        json={"name": "x"},
    ).status_code == 403
    assert client.post("/api/v2/lottery/packs", headers=h_e, json={
        "game_id": game["id"], "pack_number": "E1",
        "received_on": "2026-08-01",
    }).status_code == 403
    for action, body in (
        ("activate", {"activated_on": "2026-08-01"}),
        ("return", {"on": "2026-08-02"}),
    ):
        assert client.post(
            f"/api/v2/lottery/packs/{pack['id']}/{action}",
            headers=h_e, json=body,
        ).status_code == 403


# ── validation (422) ────────────────────────────────────────


@pytest.mark.parametrize("body", [
    {"game_number": "", "name": "n", "ticket_price": 1,
     "tickets_per_pack": 10},
    {"game_number": "1", "name": "n", "ticket_price": -1,
     "tickets_per_pack": 10},
    {"game_number": "1", "name": "n", "ticket_price": 1,
     "tickets_per_pack": 0},
    {"game_number": "1", "name": "n", "ticket_price": 1,
     "tickets_per_pack": 10001},
    {"game_number": "1", "ticket_price": 1, "tickets_per_pack": 10},
])
def test_create_game_rejects_bad_bodies(client, test_store_id, body):
    h = _h(login_admin(client, test_store_id))
    resp = client.post("/api/v2/lottery/games", headers=h, json=body)
    assert resp.status_code == 422


def test_bad_dates_and_status_are_422(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    pack = _mk_pack(client, h, game["id"])
    assert client.post("/api/v2/lottery/packs", headers=h, json={
        "game_id": game["id"], "pack_number": "D1",
        "received_on": "08/01/2026",
    }).status_code == 422
    assert client.post(
        f"/api/v2/lottery/packs/{pack['id']}/settle", headers=h,
        json={"on": "not-a-date"},
    ).status_code == 422
    assert client.get("/api/v2/lottery/day/2026-13-45",
                      headers=h).status_code == 422
    assert client.post(
        "/api/v2/lottery/day/2026-02-30/counts", headers=h,
        json={"pack_id": pack["id"], "closing_ticket": 1},
    ).status_code == 422
    assert client.get("/api/v2/lottery/packs?status=bogus",
                      headers=h).status_code == 422
    assert client.post(
        "/api/v2/lottery/day/2026-08-02/counts", headers=h,
        json={"pack_id": pack["id"], "closing_ticket": -1},
    ).status_code == 422


def test_negative_opening_ticket_is_422(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    pack = _mk_pack(client, h, game["id"], activate=False)
    resp = client.post(
        f"/api/v2/lottery/packs/{pack['id']}/activate", headers=h,
        json={"activated_on": "2026-08-01", "opening_ticket": -3},
    )
    assert resp.status_code == 422


# ── state / count guards (409) and updates ──────────────────


def test_update_game_changes_every_field(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    resp = client.put(
        f"/api/v2/lottery/games/{game['id']}", headers=h,
        json={"name": "  Renamed  ", "ticket_price": 20.0,
              "tickets_per_pack": 30},
    )
    assert resp.status_code == 200, resp.text
    g = resp.json()["game"]
    assert (g["name"], g["ticket_price"], g["tickets_per_pack"]) == (
        "Renamed", 20.0, 30)
    assert g["is_active"] is True


def test_activate_opening_ticket_at_pack_end_is_409(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h, per_pack=50)
    pack = _mk_pack(client, h, game["id"], activate=False)
    resp = client.post(
        f"/api/v2/lottery/packs/{pack['id']}/activate", headers=h,
        json={"activated_on": "2026-08-01", "opening_ticket": 50},
    )
    assert resp.status_code == 409
    # Still received, so a corrected activation works.
    resp = client.post(
        f"/api/v2/lottery/packs/{pack['id']}/activate", headers=h,
        json={"activated_on": "2026-08-01", "opening_ticket": 49},
    )
    assert resp.status_code == 200


def test_count_guards_and_upsert(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h, per_pack=50)
    pack = _mk_pack(client, h, game["id"], opening=2)

    def count(day, n):
        return client.post(
            f"/api/v2/lottery/day/{day}/counts", headers=h,
            json={"pack_id": pack["id"], "closing_ticket": n},
        )

    assert count("2026-08-02", 51).status_code == 409      # past the end
    assert count("2026-08-02", 1).status_code == 409       # below opening
    assert count("2026-08-05", 20).status_code == 200
    assert count("2026-08-03", 25).status_code == 409      # above later count
    assert count("2026-08-04", 10).status_code == 200      # between: fine

    # Re-counting the same day replaces the row (no duplicate).
    assert count("2026-08-05", 30).status_code == 200
    row = client.get("/api/v2/lottery/day/2026-08-05",
                     headers=h).json()["rows"][0]
    assert row["closing_ticket"] == 30
    assert row["previous_reference"] == 10
    assert row["sold"] == 20
    assert row["value"] == 100.0           # 20 tickets x $5
    from api.Modules.Lottery.Models import LotteryDayCount
    with db_session():
        n = db.session.query(LotteryDayCount).filter_by(
            pack_id=pack["id"], report_date=date(
                2026, 8, 5)).count()
        assert n == 1


def test_count_on_settled_pack_is_409(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    pack = _mk_pack(client, h, game["id"])
    assert client.post(
        f"/api/v2/lottery/packs/{pack['id']}/settle", headers=h,
        json={"on": "2026-08-02"},
    ).status_code == 200
    resp = client.post(
        "/api/v2/lottery/day/2026-08-03/counts", headers=h,
        json={"pack_id": pack["id"], "closing_ticket": 3},
    )
    assert resp.status_code == 409
    assert "settled" in resp.json()["detail"]


# ── audit trail ─────────────────────────────────────────────


def test_every_mutation_is_audited(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    client.put(f"/api/v2/lottery/games/{game['id']}", headers=h,
               json={"name": "Z"})
    pack = _mk_pack(client, h, game["id"])
    client.post("/api/v2/lottery/day/2026-08-02/counts", headers=h,
                json={"pack_id": pack["id"], "closing_ticket": 4})
    client.post(f"/api/v2/lottery/packs/{pack['id']}/settle", headers=h,
                json={"on": "2026-08-03"})
    pack2 = _mk_pack(client, h, game["id"], number="0002", activate=False)
    client.post(f"/api/v2/lottery/packs/{pack2['id']}/return", headers=h,
                json={"on": "2026-08-03"})
    assert _audit_actions(test_store_id) == [
        "create_lottery_game", "update_lottery_game",
        "receive_lottery_pack", "activate_lottery_pack",
        "record_lottery_count", "settle_lottery_pack",
        "receive_lottery_pack", "return_lottery_pack",
    ]


def test_rejected_mutation_writes_no_audit_row(client, test_store_id):
    h = _h(login_admin(client, test_store_id))
    game = _mk_game(client, h)
    before = len(_audit_actions(test_store_id))
    resp = client.post("/api/v2/lottery/games", headers=h, json={
        "game_number": game["game_number"], "name": "dup",
        "ticket_price": 1, "tickets_per_pack": 10,
    })
    assert resp.status_code == 409
    assert len(_audit_actions(test_store_id)) == before

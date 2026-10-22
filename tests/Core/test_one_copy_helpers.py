"""Ratchets for server helpers that exist once (2026-10-21 sweep).

Each of these was copied into controller after controller, and the
copies drifted (different error shapes for the same mistake). The
shared versions:

* ``resolve_store_scope`` (Auth/Services/principal.py) — "which store
  is this token signed into, or 403". Had 17 inline copies.
* ``parse_iso_day`` (Core/Clock.py) — a ``YYYY-MM-DD`` value or a 422
  ``{field, message}``. Had ~12 inline ``strptime`` copies.
* ``resolve_period`` (Core/Clock.py) — a report's ``from`` / ``to``.
  Had 3 copies (report endpoints, CSV export, superadmin reports).
* ``utc_now`` (Core/Clock.py) — "now in UTC". ``datetime.utcnow`` was
  called directly in ~280 places, including every model's column
  defaults (2026-10-22).
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CONTROLLERS = sorted((ROOT / "api" / "Modules").glob("*/Controllers/*.py"))


def _src(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_walk_finds_the_controllers():
    assert len(CONTROLLERS) > 25


def test_no_controller_hand_writes_the_store_scope_check():
    offenders = [
        p.relative_to(ROOT).as_posix() for p in CONTROLLERS
        if "JWT does not carry a store scope" in _src(p)
    ]
    assert offenders == [], "use resolve_store_scope(claims)"


def test_no_controller_parses_a_day_by_hand():
    # The CSV export's optional compare dates fall back to "none"
    # instead of refusing, on purpose (a bad compare date just drops
    # the comparison column).
    allow = {"api/Modules/Reports/Controllers/csv_export.py"}
    offenders = [
        p.relative_to(ROOT).as_posix() for p in CONTROLLERS
        if ".strptime(" in _src(p) and p.relative_to(ROOT).as_posix() not in allow
    ]
    assert offenders == [], "use parse_iso_day / resolve_period from api.Core.Clock"


def test_nothing_calls_utcnow_directly():
    # Alembic revisions never import application code, so they keep
    # their own clock; Clock.py is the helper itself.
    offenders = [
        p.relative_to(ROOT).as_posix()
        for top in ("api", "tests", "scripts")
        for p in sorted((ROOT / top).rglob("*.py"))
        if p.name != "test_one_copy_helpers.py"
        and p != ROOT / "api" / "Core" / "Clock.py"
        and "utcnow" in _src(p)
    ]
    assert offenders == [], "use utc_now() from api.Core.Clock"


def test_utc_now_is_naive_utc():
    from datetime import datetime, timezone

    from api.Core.Clock import utc_now

    now = utc_now()
    assert now.tzinfo is None
    real = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs((real - now).total_seconds()) < 5


def test_daily_book_checks_the_path_store_in_one_place():
    src = _src(ROOT / "api/Modules/DailyBook/Controllers/__init__.py")
    assert src.count("int(claim_store) != int(store_id)") == 1


# ── resolve_period ─────────────────────────────────────────────

TODAY = date(2026, 10, 21)


def test_blank_means_this_month_to_today():
    from api.Core.Clock import resolve_period
    assert resolve_period(None, None, today=TODAY) == (date(2026, 10, 1), TODAY)
    assert resolve_period("  ", "", today=TODAY) == (date(2026, 10, 1), TODAY)


def test_explicit_range_is_kept():
    from api.Core.Clock import resolve_period
    assert resolve_period("2026-01-05", "2026-02-10", today=TODAY) == (
        date(2026, 1, 5), date(2026, 2, 10),
    )


def test_backwards_range_is_swapped():
    from api.Core.Clock import resolve_period
    assert resolve_period("2026-03-01", "2026-02-01", today=TODAY) == (
        date(2026, 2, 1), date(2026, 3, 1),
    )


@pytest.mark.parametrize("bad", ["yesterday", "2026-13-01", "2026-02-30", "10/21/2026"])
def test_unreadable_values_fall_back_rather_than_error(bad):
    from api.Core.Clock import resolve_period
    assert resolve_period(bad, bad, today=TODAY) == (date(2026, 10, 1), TODAY)


def test_csv_export_reads_the_range_through_resolve_period():
    """The CSV download reads a backwards range the way the JSON
    report does (they used to be separate copies)."""
    from api.Modules.Reports.Controllers.csv_export import _parse_period
    d_from, d_to, _label = _parse_period({"from_": "2026-03-09", "to": "2026-03-01"}, today=TODAY)
    assert (d_from, d_to) == (date(2026, 3, 1), date(2026, 3, 9))


# ── The shared parser's 422 shape now reaches every date field ──

from tests.conftest import login_admin  # noqa: E402


def _h(client, store_id):
    return {"Authorization": f"Bearer {login_admin(client, store_id)}"}


def test_transfer_with_a_bad_send_date_names_the_field(client, test_store_id):
    resp = client.post("/api/v2/transfers", headers=_h(client, test_store_id), json={
        "send_date": "21/10/2026", "company": "Intermex",
        "service_type": "Money Transfer", "sender_name": "A", "send_amount": 10,
    })
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == "send_date"


def test_batch_with_a_bad_date_names_the_field(client, test_store_id):
    resp = client.post("/api/v2/batches", headers=_h(client, test_store_id), json={
        "ach_date": "2026-13-45", "company": "Intermex", "batch_ref": "B1",
        "ach_amount": 10,
    })
    assert resp.status_code == 422
    assert resp.get_json()["detail"]["field"] == "ach_date"


def test_signed_out_of_any_store_is_403_with_the_shared_message(client):
    """A superadmin token carries no store: store-scoped routes answer
    the one shared 403 instead of each module's own wording."""
    from tests.conftest import login_superadmin
    h = {"Authorization": f"Bearer {login_superadmin(client)}"}
    for path in ("/api/v2/batches", "/api/v2/return-checks"):
        resp = client.get(path, headers=h)
        assert resp.status_code == 403, path
        assert "store scope" in resp.get_data(as_text=True), path

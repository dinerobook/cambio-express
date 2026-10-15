"""Store-scoped "today" is the store's calendar day, not the server's.

The server runs on UTC. At 8:30pm on New Year's Eve in Chicago it is
already 02:30 on Jan 1 in UTC, so every default that read
``date.today()`` was a day — and here a year — ahead for a US store:
report and CSV period defaults, the tax-pack year picker, the
owner dashboard's return-check aging, ``ReturnCheck.days_outstanding``
and the nightly summary's "yesterday". Each now reads the store's
saved timezone; a store with none keeps the UTC day it always had.
"""
from datetime import date, datetime, timezone

import pytest

import api.Core.Clock as clock
from tests._app import db, db_session
from tests.conftest import login_admin, make_employee_client


class _NewYearsEveInChicago(datetime):
    """02:30 UTC on 2027-01-01 = 20:30 on 2026-12-31 in Chicago."""
    FIXED = datetime(2027, 1, 1, 2, 30, tzinfo=timezone.utc)

    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        return cls.FIXED.astimezone(tz) if tz else cls.FIXED.replace(tzinfo=None)


CHICAGO_TODAY = date(2026, 12, 31)
UTC_TODAY = date(2027, 1, 1)


@pytest.fixture
def nye(monkeypatch):
    monkeypatch.setattr(clock, "datetime", _NewYearsEveInChicago)


def _set_tz(store_id, tz):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        db.session.get(Store, store_id).timezone = tz
        db.session.commit()


def _h(token):
    return {"Authorization": f"Bearer {token}"}


# ── store_local_today ───────────────────────────────────────


def test_store_local_today_reads_the_stores_zone(nye, test_store_id):
    _set_tz(test_store_id, "America/Chicago")
    with db_session():
        assert clock.store_local_today(db.session, test_store_id) == CHICAGO_TODAY


def test_store_local_today_without_a_zone_is_utc(nye, test_store_id):
    _set_tz(test_store_id, "")
    with db_session():
        assert clock.store_local_today(db.session, test_store_id) == UTC_TODAY


def test_store_local_today_unknown_store_is_utc(nye):
    with db_session():
        assert clock.store_local_today(db.session, 999_999) == UTC_TODAY
        assert clock.store_local_today(db.session, None) == UTC_TODAY


# ── report period defaults (JSON + CSV) ─────────────────────


def _seed_nye_transfer(store_id, admin_id):
    from tests.conftest import seed_transfer
    seed_transfer(store_id, admin_id, send_date=CHICAGO_TODAY,
                  send_amount=100.0)


def test_report_default_period_is_the_stores_month(
    client, test_store_id, test_admin_id, nye,
):
    """No from/to: Dec 1 – Dec 31 for Chicago, so the evening's
    transfer counts."""
    _set_tz(test_store_id, "America/Chicago")
    _seed_nye_transfer(test_store_id, test_admin_id)
    resp = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={test_store_id}",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["totals"]["sent"] == 100.0


def test_report_default_period_without_a_zone_is_utc(
    client, test_store_id, test_admin_id, nye,
):
    """No timezone: the UTC month (Jan 1 – Jan 1), as before."""
    _set_tz(test_store_id, "")
    _seed_nye_transfer(test_store_id, test_admin_id)
    resp = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={test_store_id}",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["totals"]["sent"] == 0.0


def test_report_default_period_refuses_another_store(
    client, test_store_id, nye,
):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="nye-other", plan="basic",
                      email="o@nye.com", timezone="America/Chicago")
        db.session.add(other); db.session.commit()
        other_id = other.id
    resp = client.get(
        f"/api/v2/reports/sales-by-company?store_ids={other_id}",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 403


def _csv_filename(resp):
    return resp.headers["content-disposition"].split("filename=")[1].strip('"')


def test_csv_export_default_period_is_the_stores_month(
    client, test_store_id, nye,
):
    _set_tz(test_store_id, "America/Chicago")
    resp = client.get(
        "/api/v2/reports/sales-by-company.csv",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert _csv_filename(resp).endswith("_2026-12-01_2026-12-31.csv")


def test_csv_export_default_period_without_a_zone_is_utc(
    client, test_store_id, nye,
):
    _set_tz(test_store_id, "")
    resp = client.get(
        "/api/v2/reports/sales-by-company.csv",
        headers=_h(login_admin(client, test_store_id)),
    )
    assert resp.status_code == 200, resp.text
    assert _csv_filename(resp).endswith("_2027-01-01_2027-01-01.csv")


# ── tax-pack year picker ────────────────────────────────────


def _years(client, store_id):
    resp = client.get(
        "/api/v2/admin/tax-export/years",
        headers=_h(login_admin(client, store_id)),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_tax_year_default_is_the_stores_last_year(client, test_store_id, nye):
    """Still Dec 31 in Chicago: "this year" is 2026, so the default
    tax year is 2025 and 2027 is not offered yet."""
    _set_tz(test_store_id, "America/Chicago")
    body = _years(client, test_store_id)
    assert body["default_year"] == 2025
    assert 2026 in body["years"]
    assert 2027 not in body["years"]


def test_tax_year_default_without_a_zone_is_utc(client, test_store_id, nye):
    _set_tz(test_store_id, "")
    body = _years(client, test_store_id)
    assert body["default_year"] == 2026
    assert 2027 in body["years"]


def test_tax_years_refused_for_cashier(client, test_store_id, nye):
    from api.Core.Permissions import set_user_permissions
    from api.Modules.Tenancy.Models import User
    _, token = make_employee_client(test_store_id, username_suffix="nyetax")
    with db_session():
        uid = db.session.query(User).filter(
            User.username.like("%nyetax%"),
        ).first().id
    set_user_permissions(test_store_id, uid, {"transfers": {"read": True}})
    resp = client.get("/api/v2/admin/tax-export/years", headers=_h(token))
    assert resp.status_code == 403


# ── return checks ───────────────────────────────────────────


def _pending_check(store_id, bounced_on):
    from api.Modules.ReturnChecks.Models import ReturnCheck
    rc = ReturnCheck(
        store_id=store_id, customer_name="C", check_number="N",
        amount=100.0, bounced_on=bounced_on, status="pending",
    )
    db.session.add(rc); db.session.commit()
    return rc


def _aging(store_id):
    from api.Modules.Owners.Services import return_check_aging_buckets
    with db_session():
        return {
            b["label"]: b["count"]
            for b in return_check_aging_buckets(db.session, [store_id])
        }


def test_owner_aging_default_is_the_stores_day(test_store_id, nye):
    """Bounced Dec 1: 30 days old in Chicago (0–30), 31 in UTC."""
    _set_tz(test_store_id, "America/Chicago")
    with db_session():
        _pending_check(test_store_id, date(2026, 12, 1))
    by_label = _aging(test_store_id)
    assert by_label["0–30 d"] == 1
    assert by_label["31–60 d"] == 0


def test_owner_aging_default_without_a_zone_is_utc(test_store_id, nye):
    _set_tz(test_store_id, "")
    with db_session():
        _pending_check(test_store_id, date(2026, 12, 1))
    by_label = _aging(test_store_id)
    assert by_label["0–30 d"] == 0
    assert by_label["31–60 d"] == 1


def test_owner_monthly_series_default_ends_in_the_stores_month(
    test_store_id, nye,
):
    from api.Modules.Owners.Services import return_check_monthly_series
    _set_tz(test_store_id, "America/Chicago")
    with db_session():
        labels, _, _ = return_check_monthly_series(db.session, [test_store_id])
    assert labels[-1] == "2026-12"
    _set_tz(test_store_id, "")
    with db_session():
        labels, _, _ = return_check_monthly_series(db.session, [test_store_id])
    assert labels[-1] == "2027-01"


def test_days_outstanding_counts_to_the_given_day(test_store_id):
    from api.Modules.ReturnChecks.Models import ReturnCheck
    pending = ReturnCheck(bounced_on=date(2026, 12, 1), status="pending")
    assert pending.days_outstanding(CHICAGO_TODAY) == 30
    assert pending.days_outstanding(UTC_TODAY) == 31
    # A closed check freezes at its close date, whatever "today" is.
    closed = ReturnCheck(
        bounced_on=date(2026, 12, 1), status="recovered",
        status_changed_on=date(2026, 12, 11),
    )
    assert closed.days_outstanding(UTC_TODAY) == 10
    assert ReturnCheck(status="pending").days_outstanding(UTC_TODAY) == 0


# ── nightly summary ─────────────────────────────────────────


def _summary_store(slug, tz):
    from api.Modules.Tenancy.Models import Store, User
    s = Store(name=slug, slug=slug, email=f"{slug}@x.com", plan="basic",
              timezone=tz)
    db.session.add(s); db.session.commit()
    u = User(username=f"{slug}-admin", password_hash="x", role="admin",
             full_name=slug, email=f"{slug}-admin@x.com", store_id=s.id,
             notify_daily_summary=True, is_active=True)
    db.session.add(u); db.session.commit()
    return s.id


def _transfer(store_id, admin_like_id, on):
    from tests.conftest import seed_transfer
    seed_transfer(store_id, admin_like_id, send_date=on)


def _admin_of(store_id):
    from api.Modules.Tenancy.Models import User
    return db.session.query(User).filter_by(store_id=store_id).first().id


def test_daily_summary_uses_each_stores_yesterday(nye):
    from api.Modules.Notifications.Services import daily_summary as ds
    from api.Modules.Tenancy.Models import Store
    with db_session():
        chi = _summary_store("nye-chi", "America/Chicago")
        utc = _summary_store("nye-utc", "")
        # Chicago's yesterday is Dec 30; its Dec 31 is still running.
        _transfer(chi, _admin_of(chi), date(2026, 12, 30))
        _transfer(chi, _admin_of(chi), date(2026, 12, 31))
        # The zone-less store keeps the UTC yesterday, Dec 31.
        _transfer(utc, _admin_of(utc), date(2026, 12, 31))
    with db_session():
        ds.run(db.session)
    with db_session():
        assert db.session.get(Store, chi).daily_summary_sent_for == date(2026, 12, 30)
        assert db.session.get(Store, utc).daily_summary_sent_for == date(2026, 12, 31)


def test_daily_summary_skips_a_store_quiet_on_its_yesterday(nye):
    """Chicago activity only on Dec 31 (its today): nothing to send
    yet, so no stamp — it goes out on the next run."""
    from api.Modules.Notifications.Services import daily_summary as ds
    from api.Modules.Tenancy.Models import Store
    with db_session():
        chi = _summary_store("nye-chi-quiet", "America/Chicago")
        _transfer(chi, _admin_of(chi), date(2026, 12, 31))
    with db_session():
        ds.run(db.session)
    with db_session():
        assert db.session.get(Store, chi).daily_summary_sent_for is None


def test_daily_summary_explicit_date_applies_to_every_store(nye):
    from api.Modules.Notifications.Services import daily_summary as ds
    from api.Modules.Tenancy.Models import Store
    with db_session():
        chi = _summary_store("nye-chi-explicit", "America/Chicago")
        _transfer(chi, _admin_of(chi), date(2026, 12, 31))
    with db_session():
        ds.run(db.session, on_date=date(2026, 12, 31))
    with db_session():
        assert db.session.get(Store, chi).daily_summary_sent_for == date(2026, 12, 31)


def test_daily_summary_rerun_is_a_no_op(nye):
    from api.Modules.Notifications.Services import daily_summary as ds
    with db_session():
        chi = _summary_store("nye-chi-rerun", "America/Chicago")
        _transfer(chi, _admin_of(chi), date(2026, 12, 30))
    with db_session():
        ds.run(db.session)
    calls = []
    import api.Modules.Notifications.Services.daily_summary as mod
    orig = mod.compute_daily_totals

    def _spy(session, store_id, on_date):
        calls.append(store_id)
        return orig(session, store_id, on_date)

    mod.compute_daily_totals = _spy
    try:
        with db_session():
            ds.run(db.session)
    finally:
        mod.compute_daily_totals = orig
    assert chi not in calls

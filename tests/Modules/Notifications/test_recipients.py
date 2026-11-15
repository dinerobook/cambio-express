"""store_email_recipients — the one audience query behind the daily
summary, missed-shift digest, locked-day digest and trial reminders."""

from datetime import datetime, timezone

from api.Modules.Notifications.Services.recipients import store_email_recipients
from api.Modules.Tenancy.Models import Store, StoreOwnerLink, User
from tests._app import db, db_session


def _store(slug):
    s = Store(name=slug, slug=slug, plan="basic", email=f"{slug}@example.com")
    db.session.add(s); db.session.flush()
    return s


def _user(store_id, username, *, role="admin", email=None, **flags):
    u = User(
        username=username, password_hash="x", role=role, full_name=username,
        email=f"{username}@x.com" if email is None else email,
        store_id=store_id, **flags,
    )
    db.session.add(u); db.session.flush()
    return u


def test_each_email_switch_is_its_own():
    with db_session():
        s = _store("recip-switch")
        _user(s.id, "summary_only", notify_daily_summary=True, notify_locked_day_digest=False)
        _user(s.id, "digest_only", notify_daily_summary=False, notify_locked_day_digest=True)
        db.session.commit()
        summary = {u.username for u in store_email_recipients(db.session, s, "notify_daily_summary")}
        digest = {u.username for u in store_email_recipients(db.session, s, "notify_locked_day_digest")}
    assert summary == {"summary_only"}
    assert digest == {"digest_only"}


def test_admins_and_linked_owners_once_never_employees_inactive_bounced_or_blank():
    with db_session():
        s = _store("recip-who")
        home = _store("recip-owner-home")
        other = _store("recip-other")
        owner = _user(home.id, "owner1", role="owner", notify_daily_summary=True)
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=s.id))
        db.session.add(StoreOwnerLink(owner_id=owner.id, store_id=other.id))
        _user(s.id, "admin1", notify_daily_summary=True)
        _user(s.id, "cashier", role="employee", notify_daily_summary=True)
        _user(s.id, "gone", notify_daily_summary=True, is_active=False)
        _user(s.id, "noemail", email="", notify_daily_summary=True)
        _user(s.id, "bounced", notify_daily_summary=True,
              email_bounced_at=datetime(2026, 11, 1, tzinfo=timezone.utc))
        _user(other.id, "stranger", notify_daily_summary=True)
        db.session.commit()
        got = [u.username for u in store_email_recipients(db.session, s, "notify_daily_summary")]
    assert sorted(got) == ["admin1", "owner1"]

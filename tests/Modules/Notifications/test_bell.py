"""The top-bar notification bell (``/api/v2/notifications/bell``).

What these pin, per api/Modules/Notifications/CLAUDE.md "The bell":

  * opt-in: with the store's ``notification_bell`` flag off the bell
    answers ``enabled: false`` and refuses dismissals;
  * every source shows when its condition is true, disappears when
    the work is done, is hidden from a person without its
    permission (default role, store-level revoke, per-user revoke),
    its module or feature, and never shows another store's data;
  * a dismissal hides an item for that person on that STORE day
    only, Undo brings it back, tomorrow it returns;
  * "Sign in as" sees the bell but may not dismiss;
  * a broken source is skipped, the rest of the bell still answers.
"""
from __future__ import annotations

from datetime import date, timedelta

import jwt
import pytest

from tests._app import db, db_session
from tests.conftest import (
    AsgiTestClient, login_admin, login_superadmin, make_employee_client,
    owner_token_for,
)
from api.Core.Clock import utc_now

BELL = "/api/v2/notifications/bell"
DISMISS = "/api/v2/notifications/bell/dismiss"
UNDISMISS = "/api/v2/notifications/bell/undismiss"

# One fixed store day for every test; ``today`` fixture freezes it.
TODAY = date(2026, 11, 4)


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def today(monkeypatch):
    """Freeze the store day the bell reads. Records the timezone it
    was asked for, so a test can check the store's zone is used."""
    from api.Modules.Notifications.Services import bell

    state = {"day": TODAY, "zones": []}

    def fake_local_today(tz):
        state["zones"].append(tz)
        return state["day"]

    monkeypatch.setattr(bell, "local_today", fake_local_today)
    return state


def _flag(store_id, on=True):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        row = db.session.query(StoreFeatureOverride).filter_by(
            store_id=store_id, flag_key="notification_bell",
        ).first()
        if row is None:
            db.session.add(StoreFeatureOverride(
                store_id=store_id, flag_key="notification_bell", enabled=on,
            ))
        else:
            row.enabled = on
        db.session.commit()


def _override(store_id, key, on):
    from api.Modules.Billing.Models import StoreFeatureOverride
    with db_session():
        db.session.add(StoreFeatureOverride(
            store_id=store_id, flag_key=key, enabled=on,
        ))
        db.session.commit()


@pytest.fixture
def on(test_store_id, today):
    _flag(test_store_id)
    return test_store_id


@pytest.fixture
def admin(client, test_store_id):
    return _h(login_admin(client, test_store_id))


def _bell(client, headers):
    resp = client.get(BELL, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _kinds(client, headers):
    return [i["kind"] for i in _bell(client, headers)["items"]]


def _item(client, headers, kind):
    items = [i for i in _bell(client, headers)["items"] if i["kind"] == kind]
    assert len(items) == 1, items
    return items[0]


def _report(store_id, day, *, locked=False):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        db.session.add(DailyReport(
            store_id=store_id, report_date=day,
            locked_at=utc_now() if locked else None,
        ))
        db.session.commit()


def _lock(store_id, day):
    from api.Modules.DailyBook.Models import DailyReport
    with db_session():
        r = db.session.query(DailyReport).filter_by(
            store_id=store_id, report_date=day,
        ).one()
        r.locked_at = utc_now()
        db.session.commit()


def _open_entry(store_id, *, day, settle_by, amount_cents=50_000,
                kind="other_cash_out"):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        item = DailyLineItem(
            store_id=store_id, report_date=day, kind=kind,
            amount_cents=amount_cents, note="Lent",
            expects_settlement=True, settle_by=settle_by,
        )
        db.session.add(item)
        db.session.commit()
        return item.id


def _settle(store_id, origin_id, *, amount_cents):
    from api.Modules.DailyBook.Models import DailyLineItem
    with db_session():
        db.session.add(DailyLineItem(
            store_id=store_id, report_date=TODAY, kind="other_cash_in",
            amount_cents=amount_cents, settles_item_id=origin_id,
        ))
        db.session.commit()


def _bank_rows(store_id, n, *, category="", status="posted", prefix="t"):
    from api.Modules.BankSync.Models import BankTransaction, StripeBankAccount
    with db_session():
        acct = db.session.query(StripeBankAccount).filter_by(
            store_id=store_id,
        ).first()
        if acct is None:
            acct = StripeBankAccount(
                store_id=store_id, stripe_account_id=f"fca_{store_id}",
            )
            db.session.add(acct)
            db.session.flush()
        for i in range(n):
            db.session.add(BankTransaction(
                store_id=store_id, stripe_bank_account_id=acct.id,
                stripe_transaction_id=f"{prefix}_{store_id}_{i}",
                amount_cents=-1000, posted_at=utc_now(), status=status,
                category_slug=category,
            ))
        db.session.commit()


def _return_check(store_id, *, bounced_on, status="pending",
                  amount_cents=30_000):
    from api.Modules.ReturnChecks.Models import ReturnCheck
    with db_session():
        db.session.add(ReturnCheck(
            store_id=store_id, bounced_on=bounced_on, customer_name="Ann",
            amount_cents=amount_cents, status=status,
        ))
        db.session.commit()


def _second_store():
    from api.Modules.Tenancy.Models import Store, User
    with db_session():
        s = Store(name="Other", slug="other-store", plan="trial")
        db.session.add(s)
        db.session.flush()
        u = User(store_id=s.id, username="other-admin@test.com",
                 full_name="Other Admin", role="admin")
        u.set_password("testpass123!")
        db.session.add(u)
        db.session.commit()
        return s.id


def _seed_everything(store_id):
    """One of each item, all true."""
    _report(store_id, TODAY - timedelta(days=1))
    _open_entry(store_id, day=TODAY - timedelta(days=3),
                settle_by=TODAY - timedelta(days=1))
    _bank_rows(store_id, 2)
    _return_check(store_id, bounced_on=TODAY - timedelta(days=45))


# ── The switch ──────────────────────────────────────────────────


class TestOptIn:
    def test_off_by_default_even_with_work_to_do(
        self, client, admin, test_store_id, today,
    ):
        _seed_everything(test_store_id)
        body = _bell(client, admin)
        assert body == {
            "enabled": False, "store_day": None, "can_dismiss": False,
            "items": [],
        }

    def test_dismiss_refused_while_off(self, client, admin, today):
        resp = client.post(DISMISS, json={"key": "bank.to_check"},
                           headers=admin)
        assert resp.status_code == 404

    def test_declared_default_is_off(self):
        from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
        row = [f for f in DEFAULT_FEATURE_FLAGS if f[0] == "notification_bell"]
        assert row and row[0][3] is False

    def test_registry_row_turns_it_on_for_every_store(
        self, client, admin, test_store_id, today,
    ):
        from api.Modules.Billing.Models import FeatureFlag
        with db_session():
            db.session.add(FeatureFlag(
                key="notification_bell", label="Notification bell",
                enabled_by_default=True,
            ))
            db.session.commit()
        assert _bell(client, admin)["enabled"] is True

    def test_store_override_off_beats_a_global_on(
        self, client, admin, test_store_id, today,
    ):
        from api.Modules.Billing.Models import FeatureFlag
        with db_session():
            db.session.add(FeatureFlag(
                key="notification_bell", label="Notification bell",
                enabled_by_default=True,
            ))
            db.session.commit()
        _flag(test_store_id, on=False)
        assert _bell(client, admin)["enabled"] is False

    def test_on_and_nothing_to_do(self, client, admin, on):
        body = _bell(client, admin)
        assert body["enabled"] is True
        assert body["items"] == []
        assert body["store_day"] == TODAY.isoformat()
        assert body["can_dismiss"] is True

    def test_signed_out_is_refused(self, client):
        assert client.get(BELL).status_code == 401
        assert client.post(DISMISS, json={"key": "bank.to_check"}).status_code == 401

    def test_superadmin_and_umbrella_owner_get_no_bell(
        self, client, on,
    ):
        assert _bell(client, _h(login_superadmin(client)))["enabled"] is False
        owner = _h(owner_token_for([on]))
        assert _bell(client, owner)["enabled"] is False


# ── Sources ─────────────────────────────────────────────────────


class TestUnlockedDays:
    def test_yesterday_unlocked_is_due(self, client, admin, on):
        _report(on, TODAY - timedelta(days=1))
        item = _item(client, admin, "daily_book.unlocked")
        assert item == {
            "key": "daily_book.unlocked", "kind": "daily_book.unlocked",
            "urgency": "due", "count": 1,
            "day": (TODAY - timedelta(days=1)).isoformat(),
            "amount_cents": None, "view": None,
        }

    def test_groups_days_and_points_at_the_oldest(self, client, admin, on):
        for back in (1, 3, 5):
            _report(on, TODAY - timedelta(days=back))
        item = _item(client, admin, "daily_book.unlocked")
        assert item["count"] == 3
        assert item["urgency"] == "overdue"
        assert item["day"] == (TODAY - timedelta(days=5)).isoformat()

    def test_today_too_old_never_started_and_locked_do_not_show(
        self, client, admin, on,
    ):
        _report(on, TODAY)                                  # still entering
        _report(on, TODAY - timedelta(days=8))              # past look-back
        _report(on, TODAY - timedelta(days=2), locked=True)
        # TODAY - 1 was never started: no row, no nag.
        assert "daily_book.unlocked" not in _kinds(client, admin)

    def test_gone_once_locked(self, client, admin, on):
        _report(on, TODAY - timedelta(days=1))
        assert "daily_book.unlocked" in _kinds(client, admin)
        _lock(on, TODAY - timedelta(days=1))
        assert "daily_book.unlocked" not in _kinds(client, admin)

    def test_employee_without_edit_does_not_see_it(self, client, on):
        _report(on, TODAY - timedelta(days=1))
        _c, jwt_ = make_employee_client(on)
        assert _kinds(client, _h(jwt_)) == []

    def test_store_revoking_the_lock_switch_hides_it(self, client, admin, on):
        from api.Core.Permissions import (
            RBAC_DEFAULTS, set_store_permissions,
        )
        _report(on, TODAY - timedelta(days=1))
        assert "daily_book.unlocked" in _kinds(client, admin)
        matrix: dict[str, dict[str, bool]] = {}
        for perm in RBAC_DEFAULTS["admin"]:
            r, a = perm.split(".", 1)
            matrix.setdefault(r, {})[a] = not (r == "day_lock")
        set_store_permissions(on, "admin", matrix)
        assert "daily_book.unlocked" not in _kinds(client, admin)

    def test_uses_the_store_timezone(self, client, admin, on, today):
        from api.Modules.Tenancy.Models import Store
        with db_session():
            db.session.get(Store, on).timezone = "America/Chicago"
            db.session.commit()
        _bell(client, admin)
        assert today["zones"] and set(today["zones"]) == {"America/Chicago"}


class TestDueBack:
    def test_overdue_entry_shows_with_what_is_left(self, client, admin, on):
        origin = _open_entry(on, day=TODAY - timedelta(days=5),
                             settle_by=TODAY - timedelta(days=2))
        _settle(on, origin, amount_cents=20_000)
        item = _item(client, admin, "daily_book.due_back")
        assert item["urgency"] == "overdue"
        assert item["count"] == 1
        assert item["amount_cents"] == 30_000
        assert item["day"] == (TODAY - timedelta(days=2)).isoformat()

    def test_due_today_is_due_not_overdue(self, client, admin, on):
        _open_entry(on, day=TODAY - timedelta(days=1), settle_by=TODAY)
        assert _item(client, admin, "daily_book.due_back")["urgency"] == "due"

    def test_held_check_past_its_date_counts(self, client, admin, on):
        _open_entry(on, day=TODAY - timedelta(days=2), kind="check_hold",
                    settle_by=TODAY - timedelta(days=1))
        assert _item(client, admin, "daily_book.due_back")["count"] == 1

    def test_future_undated_and_paid_back_do_not_show(
        self, client, admin, on,
    ):
        _open_entry(on, day=TODAY, settle_by=TODAY + timedelta(days=3))
        _open_entry(on, day=TODAY - timedelta(days=9), settle_by=None)
        paid = _open_entry(on, day=TODAY - timedelta(days=4),
                           settle_by=TODAY - timedelta(days=1))
        _settle(on, paid, amount_cents=50_000)
        assert "daily_book.due_back" not in _kinds(client, admin)

    def test_employee_with_view_only_does_not_see_it(self, client, on):
        _open_entry(on, day=TODAY - timedelta(days=3),
                    settle_by=TODAY - timedelta(days=1))
        _c, jwt_ = make_employee_client(on)
        assert "daily_book.due_back" not in _kinds(client, _h(jwt_))

    def test_employee_granted_edit_sees_it_and_loses_it_on_revoke(
        self, client, on,
    ):
        from api.Core.Permissions import set_user_permissions
        from api.Modules.Tenancy.Models import User
        _open_entry(on, day=TODAY - timedelta(days=3),
                    settle_by=TODAY - timedelta(days=1))
        _c, jwt_ = make_employee_client(on, username_suffix="grant")
        uid = int(jwt.decode(jwt_, options={"verify_signature": False})["sub"])
        set_user_permissions(on, uid, {"daily_book": {"read": True, "update": True}})
        assert "daily_book.due_back" in _kinds(client, _h(jwt_))
        set_user_permissions(on, uid, {"daily_book": {"read": True}})
        assert "daily_book.due_back" not in _kinds(client, _h(jwt_))
        with db_session():
            assert db.session.get(User, uid) is not None


class TestBankRows:
    def test_uncategorized_rows_are_counted(self, client, admin, on):
        _bank_rows(on, 3)
        _bank_rows(on, 2, category="bank_fee", prefix="tagged")
        _bank_rows(on, 1, status="void", prefix="void")
        item = _item(client, admin, "bank.to_check")
        assert item["count"] == 3
        assert item["view"] == "uncategorized"

    def test_all_tagged_shows_nothing(self, client, admin, on):
        _bank_rows(on, 2, category="bank_fee")
        assert "bank.to_check" not in _kinds(client, admin)

    def test_with_matching_on_it_follows_the_review_count(
        self, client, admin, on,
    ):
        from api.Modules.BankSync.Services.reconcile import books_counts
        _override(on, "bank_matching", True)
        _bank_rows(on, 2)
        item = _item(client, admin, "bank.to_check")
        assert item["view"] == "review"
        with db_session():
            assert item["count"] == books_counts(db.session, on)["review"]

    def test_hidden_when_bank_sync_is_off_for_the_store(
        self, client, admin, on,
    ):
        _bank_rows(on, 2)
        _override(on, "bank_sync", False)
        assert "bank.to_check" not in _kinds(client, admin)

    def test_employee_without_bank_edit_does_not_see_it(self, client, on):
        _bank_rows(on, 2)
        _c, jwt_ = make_employee_client(on)
        assert "bank.to_check" not in _kinds(client, _h(jwt_))


class TestReturnChecks:
    def test_pending_after_thirty_days_shows(self, client, admin, on):
        _return_check(on, bounced_on=TODAY - timedelta(days=30))
        _return_check(on, bounced_on=TODAY - timedelta(days=60),
                      amount_cents=10_000)
        item = _item(client, admin, "return_checks.pending")
        assert item["count"] == 2
        assert item["amount_cents"] == 40_000
        assert item["day"] == (TODAY - timedelta(days=60)).isoformat()
        assert item["urgency"] == "overdue"

    def test_recent_and_settled_checks_do_not_show(self, client, admin, on):
        _return_check(on, bounced_on=TODAY - timedelta(days=29))
        _return_check(on, bounced_on=TODAY - timedelta(days=90),
                      status="recovered")
        assert "return_checks.pending" not in _kinds(client, admin)

    def test_hidden_when_check_cashing_module_is_off(self, client, admin, on):
        _return_check(on, bounced_on=TODAY - timedelta(days=40))
        _override(on, "module_check_cashing", False)
        assert "return_checks.pending" not in _kinds(client, admin)

    def test_employee_with_view_only_does_not_see_it(self, client, on):
        _return_check(on, bounced_on=TODAY - timedelta(days=40))
        _c, jwt_ = make_employee_client(on)
        assert "return_checks.pending" not in _kinds(client, _h(jwt_))


class TestTogether:
    def test_overdue_first_then_oldest_day(self, client, admin, on):
        _seed_everything(on)
        kinds = _kinds(client, admin)
        assert kinds == [
            "return_checks.pending",   # overdue, 45 days back
            "daily_book.due_back",     # overdue, yesterday
            "daily_book.unlocked",     # due, yesterday
            "bank.to_check",           # due, no day
        ]

    def test_another_store_never_leaks_in(self, client, admin, on):
        other = _second_store()
        _flag(other)
        _seed_everything(other)
        assert _kinds(client, admin) == []
        other_admin = _h(login_admin(client, other))
        assert len(_kinds(client, other_admin)) == 4

    def test_a_broken_source_is_skipped(
        self, client, admin, on, monkeypatch,
    ):
        from api.Modules.Notifications.Services import bell
        from api.Modules.Notifications.Services.bell.types import BellSource

        def boom(ctx):
            raise RuntimeError("source fell over")

        broken = BellSource(
            kind="bank.to_check", permissions=("bank_sync.update",),
            collect=boom,
        )
        monkeypatch.setattr(bell, "SOURCES", (broken,) + bell.SOURCES[:2])
        _seed_everything(on)
        assert _kinds(client, admin) == [
            "daily_book.due_back", "daily_book.unlocked",
        ]

    def test_a_failed_query_does_not_poison_the_next_source(
        self, client, admin, on, monkeypatch,
    ):
        from sqlalchemy import text
        from api.Modules.Notifications.Services import bell
        from api.Modules.Notifications.Services.bell.types import BellSource

        def bad_sql(ctx):
            ctx.db.execute(text("SELECT * FROM no_such_table"))
            return []

        broken = BellSource(
            kind="bank.to_check", permissions=("bank_sync.update",),
            collect=bad_sql,
        )
        monkeypatch.setattr(bell, "SOURCES", (broken,) + bell.SOURCES[:1])
        _report(on, TODAY - timedelta(days=1))
        assert _kinds(client, admin) == ["daily_book.unlocked"]


# ── Dismiss ─────────────────────────────────────────────────────


class TestDismiss:
    def test_hides_for_today_and_comes_back_tomorrow(
        self, client, admin, on, today,
    ):
        _report(on, TODAY - timedelta(days=1))
        resp = client.post(DISMISS, json={"key": "daily_book.unlocked"},
                           headers=admin)
        assert resp.status_code == 200 and resp.json() == {"ok": True}
        assert _kinds(client, admin) == []
        today["day"] = TODAY + timedelta(days=1)
        assert _kinds(client, admin) == ["daily_book.unlocked"]

    def test_undo_brings_it_back(self, client, admin, on):
        _bank_rows(on, 1)
        client.post(DISMISS, json={"key": "bank.to_check"}, headers=admin)
        assert _kinds(client, admin) == []
        resp = client.post(UNDISMISS, json={"key": "bank.to_check"},
                           headers=admin)
        assert resp.status_code == 200
        assert _kinds(client, admin) == ["bank.to_check"]

    def test_twice_is_fine_and_undo_of_nothing_is_fine(self, client, admin, on):
        for _ in range(2):
            assert client.post(DISMISS, json={"key": "bank.to_check"},
                               headers=admin).status_code == 200
        assert client.post(UNDISMISS, json={"key": "daily_book.due_back"},
                           headers=admin).status_code == 200

    def test_is_per_person(self, client, admin, on):
        from api.Core.Permissions import set_user_permissions
        _bank_rows(on, 1)
        _c, jwt_ = make_employee_client(on, username_suffix="peer")
        uid = int(jwt.decode(jwt_, options={"verify_signature": False})["sub"])
        set_user_permissions(on, uid, {"bank_sync": {"read": True, "update": True}})
        client.post(DISMISS, json={"key": "bank.to_check"}, headers=admin)
        assert _kinds(client, admin) == []
        assert _kinds(client, _h(jwt_)) == ["bank.to_check"]

    def test_unknown_key_is_refused(self, client, admin, on):
        for key in ("nope", "", "x" * 121):
            resp = client.post(DISMISS, json={"key": key}, headers=admin)
            assert resp.status_code == 422, key

    def test_a_subject_key_of_a_known_kind_is_accepted(self, client, admin, on):
        resp = client.post(
            DISMISS, json={"key": "daily_book.unlocked:2026-11-01"},
            headers=admin,
        )
        assert resp.status_code == 200

    def test_old_rows_are_cleared_on_the_next_dismissal(
        self, client, admin, on,
    ):
        from api.Modules.Notifications.Models import BellDismissal
        with db_session():
            db.session.add_all([
                BellDismissal(store_id=on, user_id=999, item_key="bank.to_check",
                              dismissed_for=TODAY - timedelta(days=31)),
                BellDismissal(store_id=on, user_id=999, item_key="bank.to_check",
                              dismissed_for=TODAY - timedelta(days=30)),
            ])
            db.session.commit()
        client.post(DISMISS, json={"key": "bank.to_check"}, headers=admin)
        with db_session():
            days = sorted(
                r.dismissed_for for r in db.session.query(BellDismissal)
            )
        assert days == [TODAY - timedelta(days=30), TODAY]

    def test_no_store_scope_cannot_dismiss(self, client, on):
        sa = _h(login_superadmin(client))
        resp = client.post(DISMISS, json={"key": "bank.to_check"}, headers=sa)
        assert resp.status_code == 403


class TestSignInAs:
    def _impersonate(self, client, store_id):
        from api.Modules.Tenancy.Models import User
        sa = _h(login_superadmin(client))
        with db_session():
            uid = db.session.query(User).filter_by(
                store_id=store_id, role="admin",
            ).first().id
        resp = client.post(f"/api/v2/superadmin/impersonate/{uid}", headers=sa)
        assert resp.status_code == 200, resp.text
        return _h(resp.json()["token"])

    def test_sees_the_bell_but_may_not_dismiss(self, on):
        _report(on, TODAY - timedelta(days=1))
        c = AsgiTestClient()
        headers = self._impersonate(c, on)
        fresh = AsgiTestClient()
        body = _bell(fresh, headers)
        assert body["enabled"] is True
        assert body["can_dismiss"] is False
        assert [i["kind"] for i in body["items"]] == ["daily_book.unlocked"]
        resp = fresh.post(DISMISS, json={"key": "daily_book.unlocked"},
                          headers=headers)
        assert resp.status_code == 403
        resp = fresh.post(UNDISMISS, json={"key": "daily_book.unlocked"},
                          headers=headers)
        assert resp.status_code == 403

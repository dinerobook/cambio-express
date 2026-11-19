"""Site-agent uploads honour the store's gates.

An agent key sends no JWT, so the subscription gate
(``SubscriptionGateMiddleware`` finds the store through the token)
and the disabled-store check in ``get_principal`` never saw an
agent upload: a store the superadmin disabled, froze, or whose
trial / subscription had lapsed kept staging files and auto-booking
days. The upload route now asks both rules itself and answers like a
signed-in write would: 403 for a disabled store, 402 (with the gate's
``reason``) for a frozen or lapsed one. Nothing is staged, and the
same key works again the moment the store is open.
"""
from datetime import timedelta

import pytest

from api.Core.Clock import utc_now
from api.Modules.PosImport.Models import PosJournalFile
from api.Modules.Tenancy.Models import Store
from tests._app import db, db_session
from tests.conftest import _starlette_client
from tests.Modules.PosImport.test_agent import (
    _admin, _agent_upload, _issue_key,
)
from tests.Modules.PosImport.test_naxml import _sale


def _key(client, test_store_id):
    """Issue a key as the admin, then drop the admin's sign-in
    cookies: a real agent sends its key and nothing else, and a
    leftover access cookie would let the subscription gate find the
    store through the admin's token, hiding the hole under test."""
    key = _issue_key(client, _admin(client, test_store_id))["key"]
    _starlette_client.cookies.clear()
    return key


def _staged_count(store_id):
    with db_session():
        return (
            db.session.query(PosJournalFile)
            .filter_by(store_id=store_id)
            .count()
        )


def _update_store(store_id, **fields):
    with db_session():
        store = db.session.get(Store, store_id)
        for name, value in fields.items():
            setattr(store, name, value)
        db.session.commit()


def _lapse_trial(store_id, *, days_past_trial_end, grace_days=4):
    end = utc_now() - timedelta(days=days_past_trial_end)
    _update_store(
        store_id, plan="trial", trial_ends_at=end,
        grace_ends_at=end + timedelta(days=grace_days),
    )


def test_disabled_store_refuses_uploads_until_enabled(client, test_store_id):
    key = _key(client, test_store_id)
    _update_store(test_store_id, is_active=False)

    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 403, resp.text
    assert resp.json() == {
        "detail": "This store has been disabled. Contact support.",
        "reason": "store_disabled",
    }
    assert _staged_count(test_store_id) == 0

    # Re-enabling restores the same key with no other step.
    _update_store(test_store_id, is_active=True)
    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 200, resp.text
    assert resp.json()["staged"] is True
    assert _staged_count(test_store_id) == 1


def test_null_is_active_still_uploads(client, test_store_id):
    """NULL ``is_active`` counts as active (store_access rule)."""
    key = _key(client, test_store_id)
    _update_store(test_store_id, is_active=None)
    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 200, resp.text


def test_frozen_store_refuses_uploads(client, test_store_id):
    key = _key(client, test_store_id)
    _update_store(test_store_id, frozen_at=utc_now())

    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 402, resp.text
    assert resp.json()["reason"] == "frozen"
    assert _staged_count(test_store_id) == 0


@pytest.mark.parametrize(("days_past", "reason"), [
    (1, "trial_ended"),      # in grace: read and export only
    (30, "subscription"),    # past grace
])
def test_lapsed_trial_refuses_uploads(client, test_store_id, days_past, reason):
    key = _key(client, test_store_id)
    _lapse_trial(test_store_id, days_past_trial_end=days_past)

    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 402, resp.text
    assert resp.json()["reason"] == reason
    assert _staged_count(test_store_id) == 0


def test_inactive_plan_refuses_uploads(client, test_store_id):
    key = _key(client, test_store_id)
    _update_store(test_store_id, plan="inactive")

    resp = _agent_upload(client, key, "PJR1.xml", _sale())
    assert resp.status_code == 402, resp.text
    assert resp.json()["reason"] == "subscription"


def test_running_trial_and_paid_plan_still_upload(client, test_store_id):
    key = _key(client, test_store_id)
    _update_store(
        test_store_id, plan="trial",
        trial_ends_at=utc_now() + timedelta(days=5),
        grace_ends_at=utc_now() + timedelta(days=9),
    )
    assert _agent_upload(client, key, "PJR1.xml", _sale()).status_code == 200

    _update_store(test_store_id, plan="pro")
    assert _agent_upload(client, key, "PJR2.xml", _sale()).status_code == 200
    assert _staged_count(test_store_id) == 2


def test_bad_key_at_a_blocked_store_is_still_the_opaque_401(
    client, test_store_id,
):
    """The key is checked first: a stranger never learns a store's
    state from the answer."""
    _key(client, test_store_id)
    _update_store(test_store_id, is_active=False)
    resp = _agent_upload(client, "pak_wrong", "PJR1.xml", _sale())
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid agent key."}

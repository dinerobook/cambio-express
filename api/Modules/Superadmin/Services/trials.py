"""Trial windows a superadmin hands out.

One place for the arithmetic the single extend, the bulk extend
and the plan edit share, so "+14 days" means the same thing on
every button:

* an extension counts from the trial's end while it is still
  running, and from NOW once it has ended — adding days to an end
  date two months in the past kept the store expired and said
  "extended" in the audit log;
* the grace window follows the new end (``DEFAULT_GRACE_DAYS``,
  the same gap signup gives);
* reviving a store that was ``inactive`` (cancelled, or lapsed)
  puts it back on ``trial`` and clears the retention timer and
  the cancellation stamp — the retention purge only looks at
  ``inactive`` stores, but a revived store still showed in the
  retention queue and the reminder emails never fired again.

Pure functions over a ``Store`` row; the caller owns the commit.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from api.Core.Clock import utc_now
from api.Modules.Auth.Services.signup import DEFAULT_GRACE_DAYS

# What the superadmin buttons default to — longer than the self-
# service signup trial on purpose: a manual extension is a favour.
DEFAULT_EXTENSION_DAYS = 14

PAID_PLANS = ("basic", "pro")


class TrialWindowError(ValueError):
    """The requested window cannot be applied (past end date, paid
    plan). The message is safe to show the superadmin."""


def _end_of_day(d: date) -> datetime:
    return datetime.combine(d, time(23, 59, 59))


def _revive(store: Any) -> list[str]:
    """Bring a store that is no longer trading back onto a trial.
    Returns the names of the fields that changed, for the audit
    row."""
    changed: list[str] = []
    if store.plan == "inactive":
        store.plan = "trial"
        changed.append("plan")
    if store.data_retention_until is not None:
        store.data_retention_until = None
        changed.append("data_retention_until")
    if store.canceled_at is not None:
        store.canceled_at = None
        changed.append("canceled_at")
    return changed


def extend_store_trial(
    store: Any, *,
    days: int | None = None,
    ends_on: date | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Move ``store.trial_ends_at`` forward.

    ``days`` adds to the later of the current end and now;
    ``ends_on`` sets the end to that calendar day (end of day,
    UTC) and must be in the future. Exactly one of the two is
    used — ``ends_on`` wins when both are given.

    Raises ``TrialWindowError`` for a paid plan (the trial window
    is meaningless there; move the plan first) or a past
    ``ends_on``.

    Returns ``{"trial_ends_at", "changed"}`` for the audit row.
    """
    now = now or utc_now()
    if store.plan in PAID_PLANS:
        raise TrialWindowError(
            "This store is on a paid plan; change its plan to "
            "\"trial\" first if you want to give it a trial window."
        )
    if ends_on is not None:
        new_end = _end_of_day(ends_on)
        if new_end <= now:
            raise TrialWindowError("The trial end date must be in the future.")
    else:
        n = DEFAULT_EXTENSION_DAYS if days is None else int(days)
        base = store.trial_ends_at
        if base is None or base < now:
            base = now
        new_end = base + timedelta(days=n)
    store.trial_ends_at = new_end
    store.grace_ends_at = new_end + timedelta(days=DEFAULT_GRACE_DAYS)
    # The "your trial ends soon" reminder is sent once per window;
    # a new window deserves its own reminder.
    store.trial_reminder_sent_at = None
    changed = ["trial_ends_at", "grace_ends_at"] + _revive(store)
    return {"trial_ends_at": new_end, "changed": changed}


def apply_plan_change(store: Any, new_plan: str, *,
                      now: datetime | None = None) -> list[str]:
    """Set ``store.plan`` the way the superadmin edit form means it.

    * off ``inactive`` → the store is trading again: clear the
      retention timer and the cancellation stamp (what the
      resubscribe webhook does);
    * onto ``trial`` with no running window → open a fresh
      ``DEFAULT_EXTENSION_DAYS`` window; a running window is kept.

    Returns the changed field names (``[]`` when the plan already
    matched).
    """
    now = now or utc_now()
    if new_plan == (store.plan or ""):
        return []
    changed = ["plan"]
    was_inactive = store.plan == "inactive"
    store.plan = new_plan
    if was_inactive and new_plan != "inactive":
        if store.data_retention_until is not None:
            store.data_retention_until = None
            changed.append("data_retention_until")
        if store.canceled_at is not None:
            store.canceled_at = None
            changed.append("canceled_at")
    if new_plan == "trial" and (
        store.trial_ends_at is None or store.trial_ends_at <= now
    ):
        store.trial_ends_at = now + timedelta(days=DEFAULT_EXTENSION_DAYS)
        store.grace_ends_at = (
            store.trial_ends_at + timedelta(days=DEFAULT_GRACE_DAYS)
        )
        store.trial_reminder_sent_at = None
        changed += ["trial_ends_at", "grace_ends_at"]
    return changed


__all__ = [
    "DEFAULT_EXTENSION_DAYS",
    "PAID_PLANS",
    "TrialWindowError",
    "apply_plan_change",
    "extend_store_trial",
]

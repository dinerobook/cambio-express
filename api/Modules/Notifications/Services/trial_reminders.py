"""Trial-reminder Service: eligibility queries + the daily-cron
``run()`` orchestrator.

Two halves:

  - **Pure queries**: ``stores_due_for_reminder`` and
    ``eligible_recipients`` return rows without sending anything,
    so they're easy to unit-test.
  - **Side-effect orchestrator**: ``run(session, now=None,
    base_url=None)`` is the cron entry point — it fans out an
    email to every eligible recipient and stamps
    ``Store.trial_reminder_sent_at`` for dedup.

Per CLAUDE.md the trial-reminder dedup flag is
``Store.trial_reminder_sent_at``. ``run()`` stamps it after
sending; the cancellation Service clears it on resubscribe so a
second trial (post-reactivation) gets its own fresh reminder.
"""
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from api.Modules.Notifications.Services.recipients import store_email_recipients

from api.Modules.Billing.Services.trial import (
    get_trial_status,
)
from api.Modules.Notifications.Services.email_text import (
    EN, email_date, email_language, email_t,
)
from api.Modules.Notifications.Services.smtp import send_email
from api.Modules.Notifications.Services.templates import render_email_template
from api.Core.Clock import utc_now


# Subject, body and push words live in email_text.py ("trial.*"), in
# English and Spanish; each recipient gets their own language. The
# English texts keep their old names for callers that import them.
TRIAL_REMINDER_SUBJECT = EN["trial.subject"]
TRIAL_REMINDER_BODY = EN["trial.body"]


def stores_due_for_reminder(db: Session, now: datetime | None = None) -> list[Any]:
    """Trial stores whose trial ends within
    `EXPIRING_SOON_THRESHOLD_DAYS` (3) days and haven't been
    reminded yet. Returns a list of `Store` rows.

    The status check is delegated to `get_trial_status` so the
    "expiring_soon" definition stays in one place.
    """
    from api.Modules.Tenancy.Models import Store
    if now is None:
        now = utc_now()
    candidates = (
        db.query(Store)
          .filter(
              Store.plan == "trial",
              Store.trial_ends_at.isnot(None),
              Store.trial_reminder_sent_at.is_(None),
          )
          .all()
    )
    return [s for s in candidates if get_trial_status(s) == "expiring_soon"]


def eligible_recipients(db: Session, store: Any) -> list[Any]:
    """Users who should get the reminder for this store: admins +
    owners with `email` set and `notify_trial_reminders=True`.

    Owners linked via `StoreOwnerLink` are picked up even though
    their `User` row sits in a different store (the multi-store
    owner pattern).

    Deduplicated — the same user could be both admin of this
    store and an owner-link target.
    """
    return store_email_recipients(db, store, "notify_trial_reminders")


def run(
    session: Session,
    *,
    now: datetime | None = None,
    base_url: str | None = None,
) -> int:
    """Send the trial-ending reminder to every eligible recipient.

    Returns the count of emails actually sent (skipping users with
    no email or ``notify_trial_reminders=False``). Idempotent on
    ``trial_reminder_sent_at``; same-day reruns are a no-op.

    The caller owns the session lifecycle — this function commits
    inside the session when at least one email goes out (so the
    dedup stamp lands), but never closes the session.
    """
    if now is None:
        now = utc_now()
    if base_url is None:
        from api.Core.Urls import get_base_url
        base_url = get_base_url()

    sent = 0
    for store in stores_due_for_reminder(session, now):
        days_left = max(0, (store.trial_ends_at - now).days)
        subscribe_url = f"{base_url}/subscribe"
        notifications_url = f"{base_url}/account/notifications"
        any_sent = False
        for u in eligible_recipients(session, store):
            lang = email_language(u)
            trial_end_str = email_date(store.trial_ends_at, lang)
            body = email_t(
                lang, "trial.body",
                name=u.full_name or u.username,
                store_name=store.name,
                trial_end_date=trial_end_str,
                days=days_left,
                subscribe_url=subscribe_url,
                notifications_url=notifications_url,
            )
            html = render_email_template(
                "emails/trial_reminder.html",
                lang=lang,
                preheader=email_t(
                    lang, "trial.preheader",
                    store_name=store.name, trial_end_date=trial_end_str,
                ),
                name=u.full_name or "",
                store_name=store.name,
                trial_end_date=trial_end_str,
                days=days_left,
                subscribe_url=subscribe_url,
                notifications_url=notifications_url,
                year=now.year,
                base_url=base_url,
            )
            subject = email_t(lang, "trial.subject", days=days_left)
            send_email(session, u.email, subject, body, html)
            # Fan out a Web Push too — best-effort, gated on the
            # per-kind toggle so a user who opted out of trial-
            # reminder pushes still gets the email.  Tag scoped to
            # the store so a later reminder for the same store
            # coalesces with the earlier one.
            try:
                from api.Modules.Notifications.Services.push import (
                    send_push, user_wants_push,
                )
                if user_wants_push(u, "trial_reminder"):
                    send_push(
                        session,
                        user_id=int(u.id),
                        title=subject,
                        body=email_t(
                            lang, "trial.preheader",
                            store_name=store.name,
                            trial_end_date=trial_end_str,
                        ),
                        url="/app/admin/subscription",
                        tag=f"trial_reminder:{store.id}",
                    )
            except Exception as exc:  # pragma: no cover — push best-effort
                import logging
                logging.getLogger(__name__).warning(
                    "trial-reminder push failed for user %s: %s",
                    u.id, exc,
                )
            any_sent = True
            sent += 1
        if any_sent:
            store.trial_reminder_sent_at = now
    if sent:
        session.commit()
    return sent

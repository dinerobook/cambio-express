"""Support-ticket update notifications.

Two directions, mirroring who acted on the ticket:

  - **Staff acted** (superadmin replied / changed status) →
    ``send_ticket_update_to_user`` emails + pushes the person who
    filed the ticket, gated on their ``notify_ticket_updates`` /
    ``notify_ticket_updates_push`` preferences.
  - **Store side acted** (new ticket, user reply, reopen) →
    ``send_ticket_event_to_platform`` emails every active
    platform recipient. Today that's superadmins only; the
    planned "support" platform role widens the recipient query
    here (single place to touch).

Both are worker entry-points for the D5 enqueue pattern
(``api.Core.Jobs.enqueue``): top-level functions, primitive args
only, each opens its own ``SessionLocal`` because the request
session is closed by the time an async worker runs. Callers fire
them AFTER committing the ticket mutation so the worker sees the
new state.

Everything is best-effort — a notification failure must never
fail the ticket mutation that triggered it.
"""
from __future__ import annotations

import logging

from sqlalchemy.orm import Session


_log = logging.getLogger(__name__)


# Event codes → the key of their words in email_text.py ("ticket.*").
# ``detail`` carries the variable part (new status, reply snippet) so
# workers stay primitive-args. Each recipient reads their own language.
_USER_EVENT_KEY = {
    "staff_reply":   "ticket.staffReply",
    "status_change": "ticket.statusChange",
}

_PLATFORM_EVENT_KEY = {
    "created":    "ticket.created",
    "user_reply": "ticket.userReply",
    "reopened":   "ticket.reopenedEvent",
}

# A status-change ``detail`` is the English status word the caller
# passed ("In progress", "Reopened"); it is shown in the reader's
# language. Anything else (a reply snippet) is the person's own words.
_STATUS_DETAIL_KEY = {
    "Open": "ticket.st.open",
    "In progress": "ticket.st.in_progress",
    "Resolved": "ticket.st.resolved",
    "Closed": "ticket.st.closed",
    "Reopened": "ticket.reopened",
}

_STATUS_KEY = {
    "open": "ticket.st.open",
    "in_progress": "ticket.st.in_progress",
    "resolved": "ticket.st.resolved",
    "closed": "ticket.st.closed",
}


def _status_label(lang: str, status: str | None) -> str:
    """A ticket status in ``lang``; one the list doesn't know shows as
    stored."""
    from api.Modules.Notifications.Services.email_text import email_t
    raw = status or "open"
    key = _STATUS_KEY.get(raw)
    return email_t(lang, key) if key else raw.replace("_", " ")


def _detail_for(lang: str, event: str, detail: str) -> str:
    from api.Modules.Notifications.Services.email_text import email_t
    key = _STATUS_DETAIL_KEY.get(detail) if event == "status_change" else None
    return email_t(lang, key) if key else detail


# English texts under their old names, for importers.
from api.Modules.Notifications.Services.email_text import EN  # noqa: E402

USER_SUBJECT = EN["ticket.userSubject"]
PLATFORM_SUBJECT = EN["ticket.platformSubject"]


def _base_url() -> str:
    from api.Core.Urls import get_base_url
    return get_base_url()


def _render_html(
    *, lang: str, heading: str, event_line: str, ticket: object,
    store_name: str, detail: str, view_url: str, cta_label: str,
    notifications_url: str | None, name: str,
) -> str | None:
    """Render the shared ticket-update email chrome. Returns None on
    template failure so callers fall back to plaintext-only."""
    from api.Core.Clock import utc_now
    from api.Modules.Notifications.Services.templates import (
        render_email_template,
    )
    try:
        return render_email_template(
            "emails/ticket_update.html",
            lang=lang,
            preheader=event_line,
            heading=heading,
            event_line=event_line,
            name=name,
            ticket_id=getattr(ticket, "id", ""),
            subject=getattr(ticket, "subject", "") or "",
            store_name=store_name,
            status=_status_label(lang, getattr(ticket, "status", "") or "open"),
            priority=getattr(ticket, "priority", "") or "normal",
            detail=detail,
            view_url=view_url,
            cta_label=cta_label,
            notifications_url=notifications_url,
            year=utc_now().year,
            base_url=_base_url(),
        )
    except Exception:  # pragma: no cover — template path
        _log.exception("ticket-update: template render failed")
        return None


def _deliver(
    db: Session, user: object, subject: str, body: str, html: str | None,
) -> int:
    """Send one email, best-effort. Returns 1 on an attempted send."""
    from api.Modules.Notifications.Services.smtp import send_email
    try:
        send_email(db, user.email, subject, body, html)  # type: ignore[attr-defined]
        return 1
    except Exception:  # pragma: no cover — best-effort SMTP
        _log.exception(
            "ticket-update: send_email failed for user_id=%s",
            getattr(user, "id", None),
        )
        return 0


def send_ticket_update_to_user(
    ticket_id: int, event: str, detail: str = "",
) -> int:
    """Notify the ticket's creator that staff acted on it.

    ``event`` ∈ ``_USER_EVENT_KEY``; ``detail`` carries the new
    status or a snippet of the staff reply. Returns emails attempted
    (0 or 1). Push fans out independently of the email gate — the
    two channels have separate toggles.
    """
    from api.Core.Database import SessionLocal
    from api.Modules.Notifications.Services.email_text import (
        email_language, email_t,
    )
    from api.Modules.Tenancy.Models import User
    from api.Modules.Support.Models import SupportTicket

    sent = 0
    with SessionLocal() as db:
        ticket = db.get(SupportTicket, ticket_id)
        if ticket is None or ticket.user_id is None:
            return 0
        user = db.get(User, ticket.user_id)
        if user is None or not user.is_active:
            return 0

        view_url = f"{_base_url()}/app/account/tickets"
        notifications_url = f"{_base_url()}/app/account/notifications"
        name = user.full_name or user.username or ""
        lang = email_language(user)
        event_line = email_t(lang, _USER_EVENT_KEY.get(event, "ticket.updated"))
        shown_detail = _detail_for(lang, event, detail)
        subject = email_t(lang, "ticket.userSubject", subject=ticket.subject or "")
        detail_block = f"{shown_detail}\n\n" if shown_detail else ""

        wants_email = (
            bool(user.email)
            and bool(getattr(user, "notify_ticket_updates", True))
            and user.email_bounced_at is None
        )
        if wants_email:
            body = email_t(
                lang, "ticket.userBody",
                name=name,
                event_line=event_line,
                subject=ticket.subject or "",
                ticket_id=ticket.id,
                detail_block=detail_block,
                view_url=view_url,
                notifications_url=notifications_url,
            )
            html = _render_html(
                lang=lang,
                heading=email_t(lang, "ticket.heading"),
                event_line=event_line,
                ticket=ticket,
                store_name="",
                detail=shown_detail,
                view_url=view_url,
                cta_label=email_t(lang, "ticket.openConversation"),
                notifications_url=notifications_url,
                name=name,
            )
            sent += _deliver(db, user, subject, body, html)

        try:
            from api.Modules.Notifications.Services.push import (
                send_push, user_wants_push,
            )
            if user_wants_push(user, "ticket_update"):
                send_push(
                    db,
                    user_id=int(user.id),
                    title=subject,
                    body=event_line + (f" — {shown_detail}" if shown_detail else ""),
                    url="/app/account/tickets",
                    tag=f"ticket_update:{ticket.id}",
                )
        except Exception as exc:  # pragma: no cover — push best-effort
            _log.warning(
                "ticket-update push failed for user %s: %s", user.id, exc,
            )
    return sent


def platform_recipients(db: Session) -> list[object]:
    """Active platform users who should hear about store-side ticket
    activity: superadmins + the tickets-only "support" role
    (the shared ``PLATFORM_STAFF_ROLES`` tuple)."""
    from api.Modules.Support.Services import PLATFORM_STAFF_ROLES
    from api.Modules.Tenancy.Models import User

    return (
        db.query(User)
          .filter(
              User.is_active == True,  # noqa: E712 — SQLAlchemy boolean
              User.role.in_(PLATFORM_STAFF_ROLES),
              User.email != "",
              User.notify_ticket_updates == True,  # noqa: E712
              User.email_bounced_at.is_(None),
          )
          .all()
    )


def send_ticket_event_to_platform(
    ticket_id: int, event: str, detail: str = "", actor_name: str = "",
) -> int:
    """Notify the platform side (superadmins) of store-side ticket
    activity: a new ticket, a user reply, or a reopen.

    Returns emails attempted. No push — the platform side works the
    queue from the superadmin tickets page.
    """
    from api.Core.Database import SessionLocal
    from api.Modules.Notifications.Services.email_text import (
        email_language, email_t,
    )
    from api.Modules.Support.Models import SupportTicket
    from api.Modules.Tenancy.Models import Store

    event_key = _PLATFORM_EVENT_KEY.get(event, "ticket.ticketUpdated")
    sent = 0
    with SessionLocal() as db:
        ticket = db.get(SupportTicket, ticket_id)
        if ticket is None:
            return 0
        store = db.get(Store, ticket.store_id)
        view_url = f"{_base_url()}/app/superadmin/tickets"
        detail_block = f"{detail}\n\n" if detail else ""
        for user in platform_recipients(db):
            lang = email_language(user)
            event_label = email_t(lang, event_key)
            store_name = (store.name if store else "") or email_t(
                lang, "ticket.storeN", id=ticket.store_id,
            )
            subject = email_t(
                lang, "ticket.platformSubject", ticket_id=ticket.id,
                store_name=store_name, event_label=event_label,
            )
            body = email_t(
                lang, "ticket.platformBody",
                event_label=event_label,
                ticket_id=ticket.id,
                subject=ticket.subject or "",
                store_name=store_name,
                actor_name=actor_name or (ticket.submitted_by or ""),
                status=_status_label(lang, ticket.status),
                priority=ticket.priority or "normal",
                detail_block=detail_block,
                view_url=view_url,
            )
            html = _render_html(
                lang=lang,
                heading=event_label,
                event_line=(
                    email_t(lang, "ticket.fromStore",
                            event_label=event_label, store_name=store_name)
                    + (f" · {actor_name}" if actor_name else "")
                ),
                ticket=ticket,
                store_name=store_name,
                detail=detail,
                view_url=view_url,
                cta_label=email_t(lang, "ticket.openQueue"),
                notifications_url=None,
                name=user.full_name or user.username or "",
            )
            sent += _deliver(db, user, subject, body, html)
    return sent

"""New sign-in alert.

When someone signs in to an account from a device it has not used
before, the person gets an email (and a push) naming the device, the
address it came from and the time, with a link to Account → Devices
where they can sign it out.

"A device it has not used before" = no earlier sign-in on this
account with the same browser + platform ("Chrome on Windows"). The
full User-Agent string is not compared: it changes with every browser
update, and an alert on every Chrome release would teach people to
ignore it. The account's very first sign-in never alerts (there is
nothing to compare against).

Preference: ``User.notify_new_sign_in`` / ``_push``. Off until the
person switches it on (owner, 2026-10-22: off for everyone by
default); NULL = never chosen = off.

``send_new_sign_in_alert`` is a worker entry-point for the D5 enqueue
pattern: top-level, primitive args, own ``SessionLocal``. Everything
is best-effort — the sign-in that triggered it never fails because of
it (the caller also wraps the enqueue).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session


_log = logging.getLogger(__name__)


DEVICES_PATH = "/app/account/sessions"

# Subject, body and push words live in email_text.py ("signIn.*"),
# in English and Spanish; each person gets their own language.


# Same heuristic as the SPA's Devices page (AccountSessions.tsx
# ``describeUserAgent``), so the email names the device the way the
# page that signs it out does. Order matters: Edge says "Chrome" too,
# Chrome says "Safari" too.
_BROWSERS: tuple[tuple[str, str], ...] = (
    (r"Edg/", "Edge"),
    (r"Firefox/", "Firefox"),
    (r"Chrome/", "Chrome"),
    (r"Safari/", "Safari"),
    (r"curl/", "curl"),
    (r"python-requests", "python-requests"),
)
_PLATFORMS: tuple[tuple[str, str], ...] = (
    (r"iPhone", "iPhone"),
    (r"iPad", "iPad"),
    (r"Android", "Android"),
    (r"Mac OS X", "macOS"),
    (r"Windows", "Windows"),
    (r"Linux", "Linux"),
)


def describe_user_agent(ua: str | None, lang: str = "en") -> str:
    """"Chrome on Windows" from a User-Agent string. The English label
    is also what ``is_new_device`` compares, so only the email passes
    ``lang``; product names stay as they are in every language."""
    from api.Modules.Notifications.Services.email_text import email_t
    if not ua:
        return email_t(lang, "signIn.unknownDevice")
    browser = next(
        (name for pat, name in _BROWSERS if re.search(pat, ua)),
        email_t(lang, "signIn.browser"),
    )
    platform = next(
        (name for pat, name in _PLATFORMS if re.search(pat, ua)), "",
    )
    return (
        email_t(lang, "signIn.deviceOn", browser=browser, platform=platform)
        if platform else browser
    )


def wants_new_sign_in(user: object, channel: str = "email") -> bool:
    """The person's choice for ``channel`` ("email" / "push"). Never
    chosen (NULL) is off."""
    column = "notify_new_sign_in" + ("_push" if channel == "push" else "")
    return bool(getattr(user, column, None))


def is_new_device(db: Session, *, user_id: int, session_id: str) -> bool:
    """True when the sign-in that minted ``session_id`` came from a
    browser + platform no earlier sign-in on this account used.

    Looks at every refresh row the account still holds (live, revoked
    or expired). No earlier rows at all → False: a first sign-in has
    nothing to be "new" against."""
    from api.Modules.Auth.Models import RefreshToken

    rows = (
        db.query(RefreshToken.session_id, RefreshToken.user_agent)
          .filter(RefreshToken.user_id == user_id)
          .all()
    )
    this = [ua for sid, ua in rows if sid == session_id]
    earlier = [ua for sid, ua in rows if sid != session_id]
    if not this or not earlier:
        return False
    device = describe_user_agent(this[0])
    return all(describe_user_agent(ua) != device for ua in earlier)


def _when(created_at: datetime, timezone: str, lang: str = "en") -> str:
    """"Oct 22, 2026 at 1:05 AM (America/Chicago)" in the zone the
    app shows this person (UTC when none is set), in their language."""
    from api.Modules.Notifications.Services.email_text import email_datetime
    zone = ZoneInfo(timezone or "UTC")
    local = created_at.replace(tzinfo=ZoneInfo("UTC")).astimezone(zone)
    return email_datetime(local, lang, timezone or "UTC")


def send_new_sign_in_alert(user_id: int, session_id: str) -> int:
    """Alert ``user_id`` that the sign-in which minted ``session_id``
    came from a new device. Returns emails attempted (0 or 1); push
    goes out independently under its own toggle."""
    from api.Core.Clock import display_timezone
    from api.Core.Database import SessionLocal
    from api.Core.Urls import get_base_url
    from api.Modules.Auth.Models import RefreshToken
    from api.Modules.Notifications.Services.email_text import (
        email_language, email_t,
    )
    from api.Modules.Tenancy.Models import Store, User

    sent = 0
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None or not user.is_active:
            return 0
        wants_email = wants_new_sign_in(user, "email")
        wants_push = wants_new_sign_in(user, "push")
        if not (wants_email or wants_push):
            return 0
        if not is_new_device(db, user_id=user_id, session_id=session_id):
            return 0
        head = (
            db.query(RefreshToken)
              .filter(RefreshToken.user_id == user_id,
                      RefreshToken.session_id == session_id)
              .order_by(RefreshToken.created_at.desc())
              .first()
        )
        if head is None:
            return 0

        store = db.get(Store, user.store_id) if user.store_id else None
        lang = email_language(user)
        device = describe_user_agent(head.user_agent, lang)
        ip = head.ip_address or email_t(lang, "signIn.unknownIp")
        when = _when(head.created_at, display_timezone(store, user), lang)
        base = get_base_url()
        devices_url = f"{base}{DEVICES_PATH}"
        notifications_url = f"{base}/app/account/notifications"
        name = user.full_name or user.username or ""

        if wants_email and user.email and user.email_bounced_at is None:
            body = email_t(
                lang, "signIn.body",
                name=name, username=user.username or "", device=device,
                ip=ip, when=when, devices_url=devices_url,
                notifications_url=notifications_url,
            )
            html = _render_html(
                lang,
                name=name, username=user.username or "", device=device,
                ip=ip, when=when, devices_url=devices_url,
                notifications_url=notifications_url,
            )
            try:
                from api.Modules.Notifications.Services.smtp import send_email
                send_email(
                    db, user.email, email_t(lang, "signIn.subject"), body, html,
                )
                sent = 1
            except Exception:  # pragma: no cover — best-effort SMTP
                _log.exception(
                    "new-sign-in: send_email failed for user_id=%s", user_id,
                )

        if wants_push:
            try:
                from api.Modules.Notifications.Services.push import send_push
                send_push(
                    db, user_id=user_id,
                    title=email_t(lang, "signIn.title"),
                    body=email_t(lang, "signIn.pushBody", device=device, ip=ip),
                    url=DEVICES_PATH,
                    tag=f"new_sign_in:{session_id}",
                )
            except Exception as exc:  # pragma: no cover — push best-effort
                _log.warning(
                    "new-sign-in push failed for user %s: %s", user_id, exc,
                )
    return sent


def _render_html(lang: str, **fields: str) -> str | None:
    """HTML body, or None on a template failure (plaintext still goes)."""
    from api.Core.Clock import utc_now
    from api.Core.Urls import get_base_url
    from api.Modules.Notifications.Services.email_text import email_t
    from api.Modules.Notifications.Services.templates import (
        render_email_template,
    )
    try:
        return render_email_template(
            "emails/new_sign_in.html",
            lang=lang,
            preheader=email_t(lang, "signIn.preheader", device=fields["device"]),
            year=utc_now().year,
            base_url=get_base_url(),
            **fields,
        )
    except Exception:  # pragma: no cover — template path
        _log.exception("new-sign-in: template render failed")
        return None

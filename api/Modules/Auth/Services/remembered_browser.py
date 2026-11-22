"""Remember this browser — the 2FA code once per browser, not at every
sign-in (owner, 2026-11-21: signing out and in again asked for the code
every time).

Ticking "Remember this browser for 30 days" on the 2FA step stores a
:class:`TrustedBrowser` row and hands the browser a random secret in the
httpOnly ``db_trusted_browser`` cookie. At the next sign-in on that
browser, once the PASSWORD has checked out,
``finalize_2fa_with_remembered_browser`` (``Services/login.py``) turns
the pending sign-in into full access without the code.

The rules (root CLAUDE.md invariant 13):

* The password is always asked. A remembered browser only stands in
  for the second factor, the way "something you have" does.
* Only the browser holding the secret, for the person it was
  remembered for. The DB keeps only ``sha256(secret)``.
* ``REMEMBER_DAYS`` from the moment the code was typed; using it does
  not extend it.
* A password change or a 2FA reset forgets every remembered browser of
  that person: ``stamp`` fingerprints the password hash and 2FA secret,
  and a remembered browser whose fingerprint no longer matches is
  refused (and its row deleted).
* Signing out does NOT forget the browser — that is the point.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.Auth.Models import TrustedBrowser, User

REMEMBER_DAYS = 30
COOKIE_NAME = "db_trusted_browser"
_MAX_SECRET_LENGTH = 200


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def stamp_for(user: User) -> str:
    """Fingerprint of what a remembered browser stands in for: the
    password and the 2FA secret it was remembered under."""
    parts = (
        str(user.password_hash or ""),
        str(user.totp_secret or ""),
        user.totp_enrolled_at.isoformat() if user.totp_enrolled_at else "",
    )
    return _hash("|".join(parts))


def remember(db: Session, user: User, *, user_agent: str | None) -> str:
    """Remember this browser for ``user``. Returns the raw secret for
    the cookie; the caller flushes / commits with the sign-in."""
    raw = secrets.token_urlsafe(32)
    now = utc_now()
    db.add(TrustedBrowser(
        user_id=user.id,
        secret_hash=_hash(raw),
        stamp=stamp_for(user),
        user_agent=(user_agent or "")[:255] or None,
        created_at=now,
        expires_at=now + timedelta(days=REMEMBER_DAYS),
    ))
    db.flush()
    return raw


def recognised(db: Session, user: User, raw: str | None) -> bool:
    """True when ``raw`` (the cookie) is a live remembered browser of
    ``user``. A row that expired or whose fingerprint no longer
    matches (password changed, 2FA reset) is deleted on the way."""
    if not raw or len(raw) > _MAX_SECRET_LENGTH:
        return False
    row = db.query(TrustedBrowser).filter_by(secret_hash=_hash(raw)).first()
    if row is None or row.user_id != user.id:
        return False
    now = utc_now()
    if row.expires_at <= now or not secrets.compare_digest(
        str(row.stamp), stamp_for(user),
    ):
        db.delete(row)
        db.flush()
        return False
    row.last_used_at = now
    db.flush()
    return True


def forget_all(db: Session, user_id: int) -> int:
    """Forget every remembered browser of one person."""
    return (
        db.query(TrustedBrowser)
          .filter(TrustedBrowser.user_id == user_id)
          .delete(synchronize_session=False)
    )

"""Who gets a store's emails: the one audience query.

The daily summary, the missed-shift digest, the locked-day digest and
the trial reminders all mail the same people: the store's admins and
the owners linked to it, active, with an email address, not
hard-bounced (Resend told us the address is dead), and with that
email's own switch on. Each switch is independent, so turning one
email off never stops another. This was four hand copies of the same
query; each sender now names only its switch.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session


def store_email_recipients(db: Session, store: Any, toggle: str) -> list[Any]:
    """Admins of ``store`` plus its linked owners whose ``User.<toggle>``
    is on. An owner linked to several stores, or both owner and admin
    here, appears once."""
    from api.Modules.Tenancy.Models import StoreOwnerLink, User

    owner_user_ids = [
        link.owner_id for link in
        db.query(StoreOwnerLink).filter_by(store_id=store.id).all()
    ]
    conds = [User.store_id == store.id]
    if owner_user_ids:
        # Owners live in a different store's user row but link back.
        conds.append(User.id.in_(owner_user_ids))
    candidates = (
        db.query(User)
          .filter(
              User.is_active == True,  # noqa: E712 — SQLAlchemy boolean
              User.role.in_(("admin", "owner")),
              User.email != "",
              getattr(User, toggle) == True,  # noqa: E712
              User.email_bounced_at.is_(None),
              or_(*conds),
          )
          .all()
    )
    return list({u.id: u for u in candidates}.values())

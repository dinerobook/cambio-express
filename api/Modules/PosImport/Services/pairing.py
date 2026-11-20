"""Connect codes: a store PC gets its agent key without a password.

DineroBook Manager (``desktop/windows/Manager``) used to sign in with
a DineroBook username and password to issue the store's agent key.
The owner's rule (2026-11-19) is that nobody at the store ever types
an id, a name or a password, as with his LdPosService. So:

1. someone with ``day_close.update`` presses "Connect a computer" on
   the Register import page and gets a code (shown as text and as a
   barcode), good for ``PAIRING_TTL`` and one use;
2. the Manager sends that code, scanned or typed, to the public
   ``POST /posimport/agent/pair`` and gets the agent key back.

The code is stored as sha256 only (like agent keys and password-reset
tokens, invariant 10). 12 characters from a 27-letter alphabet is
about 57 bits; with ten minutes of life, one use and the route's rate
limit, guessing one is out of reach. A newer code for the same store
ends any earlier unused one.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.PosImport.Models import PosAgentCredential, PosAgentPairing
from api.Modules.PosImport.Services.agent import _hash, issue_agent_key
# The TV pair code's alphabet: no 0/O, 1/I/L or 8/B, so a code read off
# a screen is typed without a mix-up.
from api.Modules.TVDisplay.Services.pair_code import (
    PAIR_CODE_ALPHABET as PAIRING_ALPHABET,
)

PAIRING_TTL = timedelta(minutes=10)
PAIRING_LENGTH = 12


def normalize_pairing_code(raw: str) -> str:
    """What a person or a barcode scanner typed, as stored: upper
    case, letters and digits only ("k7m4-q2xp 9hd3" → "K7M4Q2XP9HD3")."""
    return "".join(ch for ch in raw.upper() if ch.isascii() and ch.isalnum())


def format_pairing_code(code: str) -> str:
    """Groups of four, for reading off a screen: "K7M4-Q2XP-9HD3"."""
    return "-".join(code[i:i + 4] for i in range(0, len(code), 4))


def issue_pairing_code(
    db: Session, store_id: int, *, created_by: int | None, created_by_name: str,
) -> tuple[PosAgentPairing, str]:
    """A new connect code for the store. The raw code is returned
    exactly once (formatted); only its hash is stored."""
    now = utc_now()
    (
        db.query(PosAgentPairing)
        .filter(
            PosAgentPairing.store_id == store_id,
            PosAgentPairing.used_at.is_(None),
            PosAgentPairing.expires_at > now,
        )
        .update({PosAgentPairing.expires_at: now}, synchronize_session=False)
    )
    code = "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_LENGTH))
    row = PosAgentPairing(
        store_id=store_id, code_hash=_hash(code),
        created_by=created_by, created_by_name=created_by_name[:120],
        created_at=now, expires_at=now + PAIRING_TTL,
    )
    db.add(row)
    db.flush()
    return row, format_pairing_code(code)


@dataclass(frozen=True)
class Paired:
    pairing: PosAgentPairing
    credential: PosAgentCredential
    raw_key: str
    # The computer's earlier key, revoked because this one replaces it.
    replaced: PosAgentCredential | None

    @property
    def connected_by(self) -> str:
        """Who made the code: the store's audit log names them."""
        return str(self.pairing.created_by_name or "") or "a DineroBook user"


def redeem_pairing_code(
    db: Session, raw_code: str, *, label: str, replaces_key: str = "",
) -> Paired | None:
    """Turns a live code into a new agent key for its store. None for
    a code that is unknown, used or expired (the caller answers an
    opaque 401). ``replaces_key``: the key the computer had before; it
    is revoked when it belongs to the same store. Both go in the
    store's audit log under the person who made the code (no one signs
    in here, so there are no claims for ``audit_operator``). Caller
    commits, or rolls everything back."""
    code = normalize_pairing_code(raw_code)
    if len(code) != PAIRING_LENGTH:
        return None
    now = utc_now()
    row = db.query(PosAgentPairing).filter_by(code_hash=_hash(code)).first()
    if row is None or row.used_at is not None or row.expires_at <= now:
        return None
    # One use, even when two computers send the same code at once.
    claimed = (
        db.query(PosAgentPairing)
        .filter(PosAgentPairing.id == row.id, PosAgentPairing.used_at.is_(None))
        .update({PosAgentPairing.used_at: now}, synchronize_session=False)
    )
    if claimed != 1:
        return None
    db.refresh(row)
    credential, raw_key = issue_agent_key(db, int(row.store_id), label=label)
    row.credential_id = credential.id
    replaced = None
    if replaces_key:
        old = db.query(PosAgentCredential).filter_by(key_hash=_hash(replaces_key)).first()
        if (
            old is not None and old.store_id == row.store_id
            and old.revoked_at is None and old.id != credential.id
        ):
            old.revoked_at = now
            replaced = old
    db.flush()
    paired = Paired(pairing=row, credential=credential, raw_key=raw_key, replaced=replaced)
    _audit(db, paired)
    return paired


def _audit(db: Session, paired: Paired) -> None:
    from api.Modules.Audit.Services import record_operator_action

    made_by = paired.pairing.created_by
    user_id = int(made_by) if made_by is not None else None

    def write(cred: PosAgentCredential, action: str, summary: str) -> None:
        record_operator_action(
            db, store_id=int(paired.pairing.store_id),
            user_id=user_id, user_name=paired.connected_by,
            user_role="", target_type="pos_agent_credential",
            target_id=str(cred.id), action=action, summary=summary,
        )

    write(
        paired.credential, "issue_pos_agent_key",
        f"agent key issued ({paired.credential.label or 'unlabeled'}) "
        "to a store computer with a connect code",
    )
    if paired.replaced is not None:
        write(
            paired.replaced, "revoke_pos_agent_key",
            f"agent key revoked ({paired.replaced.label or 'unlabeled'}): "
            "its computer connected again with a connect code",
        )


__all__ = [
    "PAIRING_ALPHABET", "PAIRING_LENGTH", "PAIRING_TTL", "Paired",
    "format_pairing_code", "issue_pairing_code", "normalize_pairing_code",
    "redeem_pairing_code",
]

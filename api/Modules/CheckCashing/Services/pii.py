"""Check cashing — the customer's SSN / ITIN, encrypted at rest.

A Currency Transaction Report needs the person's taxpayer number, so
the store keeps it; nobody should be able to read it from a database
copy, a backup or a log. It is encrypted with Fernet (AES-128-CBC +
HMAC-SHA256, from ``cryptography``) under a key from the environment:

* ``CHECK_PII_KEY`` — the key for these numbers alone (Render
  generates it, ``render.yaml``). Any string; it is stretched with
  SHA-256 into a Fernet key.
* ``SECRET_KEY`` — used only while ``CHECK_PII_KEY`` is not set, and
  still tried for decryption afterwards, so numbers saved before the
  dedicated key arrived stay readable.

Only the last four digits are kept in clear (``tin_last4``) for the
masked view. Showing the whole number is a manager action, audited
(``reveal_check_customer_tin``).
"""
from __future__ import annotations

import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from api.Core.Config import settings


class PiiKeyMissing(RuntimeError):
    """No key to encrypt with: the server is not set up for SSNs."""


def _fernet(secret: str) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest()))


def _keys() -> list[Fernet]:
    secrets = [os.environ.get("CHECK_PII_KEY", ""), settings.secret_key or ""]
    keys = [_fernet(s) for s in secrets if s]
    if not keys:
        raise PiiKeyMissing("Saving an SSN is not set up on this server yet.")
    return keys


def encrypt(value: str) -> str:
    return _keys()[0].encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    """The number, or "" when nothing is stored. A token no key opens
    (the key was replaced) raises ``PiiKeyMissing``."""
    if not token:
        return ""
    try:
        return MultiFernet(_keys()).decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise PiiKeyMissing("This SSN can no longer be read with the server's key.") from exc


def mask_tin(last4: str) -> str:
    """``"1234"`` → ``"•••-••-1234"``; nothing stored → ``""``."""
    return f"•••-••-{last4}" if last4 else ""

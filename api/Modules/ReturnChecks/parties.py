"""How returned checks group by company and by customer.

Company and customer are typed by hand on each returned check, so the
same business comes back as "ACME Inc.", "Acme inc" or "ACME  INC".
``party_key`` is the one rule that decides two names are the same
party: case, accents ("José" = "Jose"), punctuation and extra spaces
are ignored, nothing else.
It is deliberately conservative (no dropping "LLC", no fuzzy match):
two different businesses must never be counted as one.

The By company / By customer lists, the check list's company and
customer filters, and the form's name suggestions all use it, so a
row in a tracking list opens exactly the checks it counted.
"""
from __future__ import annotations

import re
import unicodedata

_NOT_WORD = re.compile(r"[^0-9a-z]+")


def party_key(name: str | None) -> str:
    """``"  ACME, Inc. "`` → ``"acme inc"``; ``""`` for no name."""
    plain = "".join(
        ch for ch in unicodedata.normalize("NFKD", (name or "").casefold())
        if not unicodedata.combining(ch)
    )
    return " ".join(_NOT_WORD.sub(" ", plain).split())


__all__ = ["party_key"]

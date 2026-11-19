"""Scan codes → one identity per product (GTIN-14).

The same can of soda reaches us in several spellings: a 12-digit UPC-A
from a Modisoft export, an 11-digit code with the check digit left off,
a 13-digit EAN, or any of them zero-padded to 14. Two stores only share
a product (the universal catalog, ``retail_product``) when their codes
reduce to the same GTIN-14, so every spelling is normalized here and
nowhere else.

Conservative on purpose: a code that is not clearly a GTIN stays a
**store code** (kept exactly as typed, never shared). A wrong guess
would tie one store's item to another product everywhere; a missed
guess only means the item is not auto-filled. Store codes include PLUs
(1–6 digits: "1" is a paper bag at one store and a hot dog at the
next), codes with a bad check digit, anything with letters, and GS1
in-store numbers (UPC-A starting 2 or 4, EAN-13 020–029 / 040–049 /
200–299, GTIN-8 starting 0 or 2): random-weight deli labels and codes a
retailer or vendor program assigns itself, which mean something
different at every store.

Register exports drop digits. Two shapes were checked against a second
store's export (2026-11-18, two Modisoft price books): an 11-digit code
is a UPC-A without its check digit (45 of 112 then matched the other
store, none as typed) and a 10-digit code is a UPC-A without its
leading zero and check digit (94 of 228 matched, none as typed).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ScanKind = Literal["gtin", "store", "invalid"]

# The longest code the price book stores (PriceBookItem.pos_code).
MAX_CODE_LENGTH = 30


@dataclass(frozen=True)
class ScanCode:
    raw: str
    kind: ScanKind
    # GTIN-14 (zero-padded) when kind == "gtin", else None.
    gtin: str | None = None
    # Why a code is a store code or invalid (shown in import reports):
    # "plu", "bad_check_digit", "not_digits", "length", "in_store",
    # "empty", "all_zeros", "too_long". "check_digit_added" marks a
    # 10/11-digit UPC-A that arrived without its check digit.
    note: str = ""


def check_digit(body: str) -> int:
    """GS1 mod-10 check digit for the digits before it (same rule for
    GTIN-8, UPC-A, EAN-13 and GTIN-14)."""
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10


def has_valid_check_digit(code: str) -> bool:
    if not code.isdigit() or len(code) < 2:
        return False
    return check_digit(code[:-1]) == int(code[-1])


def is_in_store_number(gtin14: str) -> bool:
    """GS1 restricted-circulation numbers: valid check digit, but each
    retailer assigns them itself, so they are never one product."""
    if gtin14.startswith("000000"):  # GTIN-8
        return gtin14[6] in "02"
    prefix = gtin14[1:4]  # the EAN-13 prefix (UPC-A = "0" + its digits)
    return prefix[:2] in ("02", "04") or prefix[0] == "2"


def _gtin(raw: str, full: str, note: str = "") -> ScanCode:
    gtin = full.zfill(14)
    if is_in_store_number(gtin):
        return ScanCode(raw, "store", note="in_store")
    return ScanCode(raw, "gtin", gtin=gtin, note=note)


def normalize_scan_code(raw: object) -> ScanCode:
    code = str(raw if raw is not None else "").strip()
    if not code:
        return ScanCode(code, "invalid", note="empty")
    if len(code) > MAX_CODE_LENGTH:
        return ScanCode(code, "invalid", note="too_long")
    if not code.isdigit():
        return ScanCode(code, "store", note="not_digits")
    if set(code) == {"0"}:
        return ScanCode(code, "invalid", note="all_zeros")
    n = len(code)
    if n <= 6:
        return ScanCode(code, "store", note="plu")
    if n in (8, 12, 13, 14):
        if has_valid_check_digit(code):
            return _gtin(code, code)
        return ScanCode(code, "store", note="bad_check_digit")
    if n in (10, 11):
        # UPC-A without its check digit (11) or without its leading
        # zero and check digit (10) — see the module docstring.
        body = code.zfill(11)
        return _gtin(code, body + str(check_digit(body)), "check_digit_added")
    return ScanCode(code, "store", note="length")


__all__ = [
    "MAX_CODE_LENGTH", "ScanCode", "ScanKind", "check_digit",
    "has_valid_check_digit", "is_in_store_number", "normalize_scan_code",
]

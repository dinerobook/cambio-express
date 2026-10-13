"""The store's transfer-country list.

The transfer form's country picker shows the store's own list, which
a store admin manages under Settings → General → Transfer countries
(the same page as the money transfer companies). It is stored as a
CSV in `Store.transfer_countries`, in display order.

  - `store_transfer_countries(store)` — the list for the form. NULL /
    empty column (every store until an admin edits it) falls back to
    `TRANSFER_COUNTRIES`, the list the form has always shown, so no
    store sees a change until it chooses one. The only function that
    reads the column.
  - `encode_transfer_countries(names)` — validate a Settings payload
    and encode the CSV. Raises ValueError with an operator-readable
    message.

The list only drives the picker. Saved transfers keep whatever
country they were saved with, so removing a country never rewrites
history, and the federal-tax rule still keys on the name
(`DOMESTIC_COUNTRIES` in tax.py: "United States" is tax-free).

Pure functions — no DB writes, no I/O. The write path goes through
`update_store_info` (Admin Services).
"""
from typing import Any

from api.Modules.Transfers.Services.tax import TRANSFER_COUNTRIES


# Country names land in Transfer.country (String(60)).
MAX_TRANSFER_COUNTRY_NAME_LEN = 60
MAX_TRANSFER_COUNTRIES = 100


def store_transfer_countries(store: Any) -> list[str]:
    """The countries the store's transfer form offers, in order.
    Returns a fresh list every call."""
    raw = getattr(store, "transfer_countries", None) if store else None
    names = [c.strip() for c in str(raw or "").split(",") if c.strip()]
    return names or list(TRANSFER_COUNTRIES)


def encode_transfer_countries(names: list[str]) -> str:
    """Validate + encode the Settings list into the CSV column.

    Rules: 1..MAX_TRANSFER_COUNTRIES names, each trimmed, non-empty,
    at most MAX_TRANSFER_COUNTRY_NAME_LEN characters, no commas (CSV
    encoding), no case-insensitive duplicates.
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = str(raw or "").strip()
        if not name:
            raise ValueError("Country names cannot be empty.")
        if len(name) > MAX_TRANSFER_COUNTRY_NAME_LEN:
            raise ValueError(
                f"Country name {name!r} is too long "
                f"(max {MAX_TRANSFER_COUNTRY_NAME_LEN} characters)."
            )
        if "," in name:
            raise ValueError("Country names cannot contain commas.")
        if name.lower() in seen:
            raise ValueError(f"Duplicate country {name!r}.")
        seen.add(name.lower())
        out.append(name)
    if not out:
        raise ValueError("Keep at least one country for the transfer form.")
    if len(out) > MAX_TRANSFER_COUNTRIES:
        raise ValueError(
            f"At most {MAX_TRANSFER_COUNTRIES} countries are supported."
        )
    return ",".join(out)

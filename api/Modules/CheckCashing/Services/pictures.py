"""Check cashing — pictures of checks, IDs and customers.

The only writer of ``msb_check_picture`` (INVARIANTS "Pictures").

Every picture the browser sends is opened, turned upright, stripped of
its metadata (camera, place, time), shrunk to at most ``MAX_SIDE``
pixels and saved again as JPEG: what is stored is always a clean
picture of known size, never the file as sent.

* A check picture (front / back) is saved first, unattached, and joins
  its check when the check is saved (``attach_check_pictures``). One
  left behind (the cashier cleared the form) is removed after a day.
* An ID picture belongs to one of a customer's IDs; the photo to the
  customer. A new one takes the place of the old, which is kept
  (``replaced_at``) as history.
"""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from api.Core.Clock import utc_now
from api.Modules.CheckCashing.Models import (
    CHECK_PICTURE_KINDS,
    ID_PICTURE_KINDS,
    CashedCheck,
    CheckCustomer,
    CheckCustomerId,
    CheckPicture,
)
from api.Modules.CheckCashing.Services import (
    CheckCashingConflictError,
    CheckCashingNotFoundError,
    get_customer,
)

# What the browser may send, before the clean-up (the base64 text is a
# third bigger).
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
# Refuse a picture whose pixels alone would take too much memory to
# open (a "decompression bomb").
MAX_PIXELS = 40_000_000
# The longest side kept: a check at 200 dots per inch is about 1,250
# pixels wide, an ID card about 700.
MAX_SIDE = 1600
JPEG_QUALITY = 82
ACCEPTED_FORMATS = ("JPEG", "PNG", "WEBP")
# A check picture not attached to a check after this long is removed.
UNATTACHED_KEEP = timedelta(days=1)


@dataclass
class CleanPicture:
    data: bytes
    width: int
    height: int


def clean_picture(raw: bytes) -> CleanPicture:
    """Open what the browser sent and save it again as a plain JPEG.
    Raises ``CheckCashingConflictError`` for anything that is not a
    picture we accept."""
    if not raw:
        raise CheckCashingConflictError("The picture is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise CheckCashingConflictError("The picture is too large (8 MB at most).")
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            fmt = probe.format
            width, height = probe.size
            if fmt not in ACCEPTED_FORMATS:
                raise CheckCashingConflictError(
                    "Send a JPEG, PNG or WebP picture.",
                )
            if width * height > MAX_PIXELS:
                raise CheckCashingConflictError("The picture is too large.")
            probe.verify()
        with Image.open(io.BytesIO(raw)) as img:
            img.load()
            upright = ImageOps.exif_transpose(img)
            mode = "L" if upright.mode in ("1", "L", "LA", "I;16") else "RGB"
            pic = upright.convert(mode)
    except CheckCashingConflictError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise CheckCashingConflictError("This file is not a picture we can read.")
    pic.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    pic.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return CleanPicture(out.getvalue(), pic.width, pic.height)


def _new_row(
    store_id: int, kind: str, clean: CleanPicture, user_id: int,
) -> CheckPicture:
    return CheckPicture(
        store_id=store_id, kind=kind, mime="image/jpeg",
        width=clean.width, height=clean.height, size_bytes=len(clean.data),
        sha256=hashlib.sha256(clean.data).hexdigest(), data=clean.data,
        created_by=user_id, created_at=utc_now(),
    )


def _drop_stale_unattached(db: Session, store_id: int) -> None:
    db.query(CheckPicture).filter(
        CheckPicture.store_id == store_id,
        CheckPicture.kind.in_(CHECK_PICTURE_KINDS),
        CheckPicture.cashed_check_id.is_(None),
        CheckPicture.created_at < utc_now() - UNATTACHED_KEEP,
    ).delete(synchronize_session=False)


def add_check_picture(
    db: Session, store_id: int, *, kind: str, raw: bytes, user_id: int,
) -> CheckPicture:
    """A picture of the check on the counter, before it is saved."""
    if kind not in CHECK_PICTURE_KINDS:
        raise CheckCashingConflictError("Not a check picture.")
    clean = clean_picture(raw)
    _drop_stale_unattached(db, store_id)
    row = _new_row(store_id, kind, clean, user_id)
    db.add(row)
    db.flush()
    return row


def _replace(db: Session, **owner: int | str) -> None:
    db.query(CheckPicture).filter_by(replaced_at=None, **owner).update(
        {"replaced_at": utc_now()}, synchronize_session=False,
    )


def add_customer_picture(
    db: Session, store_id: int, store_ids: list[int], *, customer_id: int,
    kind: str, raw: bytes, user_id: int, id_row_id: int | None = None,
) -> tuple[CheckPicture, CheckCustomer, CheckCustomerId | None]:
    """The customer's photo, or a picture of one of their IDs. The
    picture it replaces is kept as history."""
    customer = get_customer(db, store_ids, customer_id)
    id_row: CheckCustomerId | None = None
    if kind in ID_PICTURE_KINDS:
        id_row = next((i for i in customer.ids if i.id == id_row_id), None)
        if id_row is None:
            raise CheckCashingNotFoundError("ID not found")
    elif kind != "photo":
        raise CheckCashingConflictError("Not a customer picture.")
    clean = clean_picture(raw)
    if id_row is not None:
        _replace(db, customer_id_doc_id=int(id_row.id), kind=kind)
    else:
        _replace(db, customer_id=int(customer.id), kind="photo")
    row = _new_row(store_id, kind, clean, user_id)
    row.customer_id = customer.id
    row.customer_id_doc_id = id_row.id if id_row is not None else None
    db.add(row)
    customer.updated_at = utc_now()
    db.flush()
    return row, customer, id_row


def attach_check_pictures(
    db: Session, store_id: int, check: CashedCheck, picture_ids: list[int],
) -> list[CheckPicture]:
    """Give the check its pictures: taken at this store's computer, of
    a check, not yet on another check, one of each side."""
    if not picture_ids:
        return []
    rows = (
        db.query(CheckPicture)
        .filter(CheckPicture.id.in_(set(picture_ids)))
        .all()
    )
    if len(rows) != len(set(picture_ids)) or any(
        r.store_id != store_id or r.kind not in CHECK_PICTURE_KINDS
        or r.cashed_check_id is not None
        for r in rows
    ):
        raise CheckCashingConflictError(
            "A check picture is missing. Take the picture again.",
        )
    kinds = [r.kind for r in rows]
    if len(kinds) != len(set(kinds)):
        raise CheckCashingConflictError("Send one picture of each side.")
    for r in rows:
        r.cashed_check_id = check.id
    db.flush()
    return rows


def get_picture(db: Session, store_ids: list[int], picture_id: int) -> CheckPicture:
    """A picture any store of the owner umbrella may look at."""
    row = db.get(CheckPicture, picture_id)
    if row is None or row.store_id not in store_ids:
        raise CheckCashingNotFoundError("Picture not found")
    return row


def current_pictures(
    db: Session, *, customer_ids: list[int] | None = None,
    check_ids: list[int] | None = None,
) -> list[CheckPicture]:
    """The live pictures (not replaced) of these customers or checks,
    without their bytes."""
    query = db.query(CheckPicture).filter(CheckPicture.replaced_at.is_(None))
    if customer_ids is not None:
        query = query.filter(CheckPicture.customer_id.in_(customer_ids or [-1]))
    if check_ids is not None:
        query = query.filter(CheckPicture.cashed_check_id.in_(check_ids or [-1]))
    return query.order_by(CheckPicture.id).all()


def picture_ids_by(rows: list[CheckPicture], key: str) -> dict[Any, dict[str, int]]:
    """``{owner id: {kind: picture id}}`` for ``key`` (an owner column);
    the newest wins."""
    out: dict[Any, dict[str, int]] = {}
    for r in rows:
        owner = getattr(r, key)
        if owner is not None:
            out.setdefault(owner, {})[r.kind] = int(r.id)
    return out


def delete_id_pictures(db: Session, id_row_id: int) -> None:
    """An ID removed from a profile takes its pictures with it."""
    db.query(CheckPicture).filter_by(customer_id_doc_id=id_row_id).delete(
        synchronize_session=False,
    )


def rehome_pictures(db: Session, store_id: int) -> None:
    """Retention purge, after ``rehome_shared_parties``: pictures of a
    customer who moved to a sibling store move with them; pictures that
    other stores took of a customer who is being deleted go with the
    customer."""
    for customer in db.query(CheckCustomer).filter(
        CheckCustomer.store_id != store_id,
    ).join(CheckPicture, CheckPicture.customer_id == CheckCustomer.id).filter(
        CheckPicture.store_id == store_id,
    ).distinct().all():
        db.query(CheckPicture).filter_by(
            customer_id=customer.id, store_id=store_id,
        ).update({"store_id": customer.store_id}, synchronize_session=False)
    doomed = [int(c) for (c,) in db.query(CheckCustomer.id).filter_by(store_id=store_id)]
    if doomed:
        db.query(CheckPicture).filter(
            CheckPicture.customer_id.in_(doomed),
        ).delete(synchronize_session=False)
    # A login of the doomed store that took a picture at a sibling
    # store: the picture stays, the pointer goes.
    from api.Modules.Tenancy.Models import User
    user_ids = [int(u) for (u,) in db.query(User.id).filter_by(store_id=store_id)]
    if user_ids:
        db.query(CheckPicture).filter(
            CheckPicture.store_id != store_id,
            CheckPicture.created_by.in_(user_ids),
        ).update({"created_by": None}, synchronize_session=False)
    db.flush()

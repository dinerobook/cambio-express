"""File uploads that arrive as base64 text in a JSON body.

The app has no multipart parser: a page reads the file in the browser
(``fileToBase64`` in ``frontend/src/lib/files.ts``) and posts it as
``content_base64``. Two helpers every such route shares:

* ``b64_len(n)`` — the longest base64 text that decodes to ``n`` bytes.
  A request model puts it on the field's ``max_length`` so an oversized
  body is refused before anything is decoded or held in memory twice.
* ``decode_base64(text, detail=...)`` — the bytes, or a 422 carrying the
  route's own sentence. A ``data:…;base64,`` prefix (what a browser's
  FileReader hands back) is dropped first.
"""
from __future__ import annotations

import base64
import binascii

from fastapi import HTTPException


def b64_len(decoded_bytes: int) -> int:
    """Longest base64 text that decodes to ``decoded_bytes``."""
    return (decoded_bytes + 2) // 3 * 4


def decode_base64(
    text: str, *, detail: str = "The file is not valid base64.",
) -> bytes:
    body = text.split(",", 1)[1] if text.startswith("data:") else text
    try:
        return base64.b64decode(body, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail=detail)


__all__ = ["b64_len", "decode_base64"]

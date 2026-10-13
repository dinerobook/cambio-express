"""GET /tv/logo/{catalog_type}/{slug} (api/PublicRoutes.py).

Public, unauthenticated: the TV rate board loads company and bank
logos from here. Pinned: the stored bytes come back with their own
type, a year-long immutable cache and nosniff; an unknown catalog
type, an unknown slug, the other catalog's slug, and a row whose
type is not on the image whitelist (a stored HTML/JS blob must
never be served from our origin) all 404.
"""
import pytest

from tests._app import db, db_session

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"/>'


def _logo(catalog_type, slug, mime, blob):
    from api.Modules.TVDisplay.Models import TVCatalogLogo
    with db_session():
        db.session.add(TVCatalogLogo(
            catalog_type=catalog_type, slug=slug, mime_type=mime,
            blob=blob, file_size=len(blob),
        ))
        db.session.commit()


@pytest.mark.parametrize("catalog_type,slug,mime,blob", [
    ("company", "zz-test-co", "image/png", PNG),
    ("bank", "zz-test-bank", "image/svg+xml", SVG),
])
def test_serves_the_stored_logo(client, catalog_type, slug, mime, blob):
    _logo(catalog_type, slug, mime, blob)
    resp = client.get(f"/tv/logo/{catalog_type}/{slug}")
    assert resp.status_code == 200
    assert resp.content == blob
    assert resp.mimetype == mime
    assert resp.headers["content-length"] == str(len(blob))
    assert resp.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert resp.headers["x-content-type-options"] == "nosniff"


def test_needs_no_sign_in(client):
    _logo("company", "zz-anon", "image/webp", b"RIFFxxxxWEBP")
    # The fixture client carries no cookie or bearer token.
    resp = client.get("/tv/logo/company/zz-anon")
    assert resp.status_code == 200


def test_unknown_catalog_type_is_404(client):
    _logo("company", "zz-test-co", "image/png", PNG)
    assert client.get("/tv/logo/store/zz-test-co").status_code == 404


def test_unknown_slug_is_404(client):
    assert client.get("/tv/logo/company/zz-no-such-logo").status_code == 404


def test_a_slug_is_looked_up_in_its_own_catalog_only(client):
    _logo("company", "zz-only-company", "image/png", PNG)
    assert client.get("/tv/logo/bank/zz-only-company").status_code == 404


@pytest.mark.parametrize("mime", ["text/html", "application/javascript", "image/gif"])
def test_a_type_off_the_whitelist_is_never_served(client, mime):
    _logo("company", "zz-bad-type", mime, b"<script>alert(1)</script>")
    resp = client.get("/tv/logo/company/zz-bad-type")
    assert resp.status_code == 404
    assert b"script" not in resp.content

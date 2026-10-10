"""TV board context builder + pair-code helpers (service level).

`build_tv_board_context` feeds the public kiosk template: it must
resolve catalog slugs to display names (including RETIRED catalog
rows), build cache-busted logo URLs only for rows that have a logo,
keep country / bank ordering, and attach each bank's rates. The pair
helpers mint the code + device token the Fire TV app uses.
"""
from datetime import datetime

import pytest

from tests._app import db, db_session


def _display(store_id):
    from api.Modules.TVDisplay.Models import TVDisplay
    d = TVDisplay(store_id=store_id, public_token="tok-board-test")
    db.session.add(d)
    db.session.commit()
    return d


def _store(store_id):
    from api.Modules.Tenancy.Models import Store
    return db.session.get(Store, store_id)


def _country(display_id, name, order, companies=""):
    from api.Modules.TVDisplay.Models import TVDisplayCountry
    c = TVDisplayCountry(display_id=display_id, country_name=name,
                         sort_order=order, mt_companies=companies)
    db.session.add(c)
    db.session.commit()
    return c


def _bank(country_id, name, order=0):
    from api.Modules.TVDisplay.Models import TVDisplayPayoutBank
    b = TVDisplayPayoutBank(country_id=country_id, bank_name=name,
                            sort_order=order)
    db.session.add(b)
    db.session.commit()
    return b


def test_board_context_empty_display(test_store_id):
    from api.Modules.TVDisplay.Services.board import build_tv_board_context
    with db_session():
        d = _display(test_store_id)
        ctx = build_tv_board_context(d, _store(test_store_id), db.session)
        assert ctx["sections"] == []
        assert ctx["global_companies"] == []
        assert ctx["global_company_labels"] == []
        assert ctx["display"] is d


def test_board_context_resolves_names_orders_and_dedupes(test_store_id):
    from api.Modules.TVDisplay.Models import (
        TVBankCatalog, TVCompanyCatalog, TVDisplayRate,
    )
    from api.Modules.TVDisplay.Services.board import build_tv_board_context
    with db_session():
        db.session.add_all([
            TVCompanyCatalog(slug="zz_co_a", display_name="Co Alpha"),
            # Retired catalog rows must still resolve for old boards.
            TVCompanyCatalog(slug="zz_co_b", display_name="Co Beta",
                             is_active=False),
            TVBankCatalog(slug="zz_bank", display_name="Zed Bank"),
        ])
        d = _display(test_store_id)
        c2 = _country(d.id, "Second", 2, "zz_co_b,zz_unknown")
        c1 = _country(d.id, "First", 1, " zz_co_a , zz_co_b ")
        b2 = _bank(c1.id, "Later", 5)
        b1 = _bank(c1.id, "Sooner", 1)
        db.session.add(TVDisplayRate(bank_id=b1.id, mt_company="zz_co_a",
                                     rate=17.25))
        db.session.commit()

        ctx = build_tv_board_context(d, _store(test_store_id), db.session)

        assert [s["country"].country_name for s in ctx["sections"]] == [
            "First", "Second"]
        # Union across countries, first-seen order, no duplicates.
        assert ctx["global_companies"] == [
            "zz_co_a", "zz_co_b", "zz_unknown"]
        # Unknown slugs fall back to the slug itself.
        assert ctx["global_company_labels"] == [
            "Co Alpha", "Co Beta", "zz_unknown"]
        assert ctx["bank_name_by_slug"]["zz_bank"] == "Zed Bank"
        first = ctx["sections"][0]
        assert [b.bank_name for b in first["banks"]] == ["Sooner", "Later"]
        assert first["rates"] == {(b1.id, "zz_co_a"): 17.25}
        assert ctx["sections"][1]["banks"] == []
        assert ctx["sections"][1]["rates"] == {}
        assert b2.id not in {k[0] for k in first["rates"]}


def test_board_context_logo_urls_only_when_logo_set(test_store_id):
    from api.Modules.TVDisplay.Models import (
        TVBankCatalog, TVCatalogLogo, TVCompanyCatalog,
    )
    from api.Modules.TVDisplay.Services.board import build_tv_board_context
    with db_session():
        stamp = datetime(2026, 1, 2, 3, 4, 5)
        db.session.add_all([
            TVCompanyCatalog(slug="zz_logo_co", display_name="Logo Co",
                             logo_url="/x.png"),
            TVCompanyCatalog(slug="zz_plain_co", display_name="Plain Co"),
            TVBankCatalog(slug="zz_logo_bank", display_name="Logo Bank",
                          logo_url="/y.png"),
            TVBankCatalog(slug="zz_nover_bank", display_name="No Version",
                          logo_url="/z.png"),
            TVCatalogLogo(catalog_type="company", slug="zz_logo_co",
                          mime_type="image/png", blob=b"x", file_size=1,
                          updated_at=stamp),
            TVCatalogLogo(catalog_type="bank", slug="zz_logo_bank",
                          mime_type="image/png", blob=b"x", file_size=1,
                          updated_at=stamp),
        ])
        d = _display(test_store_id)
        _country(d.id, "Land", 0, "zz_logo_co,zz_plain_co")
        ctx = build_tv_board_context(d, _store(test_store_id), db.session)

        version = int(stamp.timestamp())
        assert ctx["global_company_logos"] == [
            f"/tv/logo/company/zz_logo_co?v={version}", ""]
        assert ctx["bank_logo_by_slug"]["zz_logo_bank"] == (
            f"/tv/logo/bank/zz_logo_bank?v={version}")
        # A logo_url without an uploaded blob row has no cache-bust.
        assert ctx["bank_logo_by_slug"]["zz_nover_bank"] == (
            "/tv/logo/bank/zz_nover_bank")


def test_board_context_does_not_leak_other_displays_countries(test_store_id):
    from api.Modules.Tenancy.Models import Store
    from api.Modules.TVDisplay.Models import TVDisplay
    from api.Modules.TVDisplay.Services.board import build_tv_board_context
    with db_session():
        other = Store(name="Other TV", slug="other-tv",
                      email="o@x.com", plan="basic")
        db.session.add(other)
        db.session.commit()
        od = TVDisplay(store_id=other.id, public_token="tok-other")
        db.session.add(od)
        db.session.commit()
        _country(od.id, "Hidden Land", 0)
        d = _display(test_store_id)
        ctx = build_tv_board_context(d, _store(test_store_id), db.session)
        assert ctx["sections"] == []


# ── pair code helpers ───────────────────────────────────────


def test_generate_pair_code_shape():
    from api.Modules.TVDisplay.Services.pair_code import (
        PAIR_CODE_ALPHABET, generate_pair_code,
    )
    for _ in range(50):
        code = generate_pair_code()
        assert len(code) == 6
        assert set(code) <= set(PAIR_CODE_ALPHABET)


def test_device_token_retries_on_collision(monkeypatch):
    from api.Modules.TVDisplay.Models import TVPairing
    from api.Modules.TVDisplay.Services import pair_code
    from api.Modules.TVDisplay.Models import TVDisplay
    with db_session():
        from api.Modules.Tenancy.Models import Store
        s = Store(name="Pair Co", slug="pair-co", email="p@x.com",
                  plan="basic")
        db.session.add(s)
        db.session.commit()
        d = TVDisplay(store_id=s.id, public_token="tok-pair")
        db.session.add(d)
        db.session.commit()
        db.session.add(TVPairing(display_id=d.id, device_token="taken"))
        db.session.commit()

        tokens = iter(["taken", "taken", "fresh"])
        monkeypatch.setattr(pair_code.secrets, "token_urlsafe",
                            lambda n: next(tokens))
        assert pair_code.generate_device_token(db.session) == "fresh"


def test_device_token_gives_up_after_eight_collisions(monkeypatch):
    from api.Modules.TVDisplay.Models import TVPendingPair
    from api.Modules.TVDisplay.Services import pair_code
    with db_session():
        db.session.add(TVPendingPair(code="ABCDEF", device_token="dup",
                                     expires_at=datetime(2030, 1, 1)))
        db.session.commit()
        monkeypatch.setattr(pair_code.secrets, "token_urlsafe",
                            lambda n: "dup")
        with pytest.raises(RuntimeError):
            pair_code.generate_device_token(db.session)

"""Hourly sales (G-3): parser hour extraction, live staging
increments, commit-time rebuild, and the dashboard block.

The invariants under test:
  * ``event_hour`` is the hour the event STARTED (<EventStartTime>),
    else the hour it ended (<EventEndTime>); never <ReceiptTime>
    and never the JournalHeader's <BeginTime>, which on real
    Passport files is the report period's start (the ~22:50 day
    close), and None when the event carries no start or end (day
    totals unaffected either way),
  * each staged sale/refund increments its store-level hour bucket
    live; duplicate uploads never double-count,
  * committing a day REBUILDS its buckets from the staged
    originals (self-healing, idempotent),
  * the admin dashboard's sales block carries the two most recent
    hourly days as the chart payload.
"""
from tests.Modules.PosImport.test_agent import (
    _admin, _agent_upload, _headers, _issue_key,
)
from tests.Modules.PosImport.test_ingest import _map_codes, _mk_department
from tests.Modules.PosImport.test_naxml import _sale
from tests._app import db, db_session


def _buckets(store_id, day_iso):
    from datetime import date as _date

    from api.Modules.DayClose.Models import HourlySale
    with db_session():
        rows = (
            db.session.query(HourlySale)
            .filter_by(
                store_id=store_id,
                report_date=_date.fromisoformat(day_iso),
            )
            .all()
        )
        return {int(r.hour): int(r.amount_cents) for r in rows}


def _passport(start=None, *, receipt=None, end=None,
              business_date="2024-10-16", period="2024-10-16 22:51:54",
              **sale):
    """A sale shaped like a real Passport 22.01 file: the header's
    Begin stamp is the report PERIOD's start (the site's day close;
    EndDate 2100-01-01 while the period is open), the same on every
    file of the business day; the event carries its own start, end
    and receipt as separate date and time elements, in Passport's
    order. Stamps are "YYYY-MM-DD HH:MM:SS"; None leaves one out."""
    def stamp(prefix, value):
        if value is None:
            return ""
        day, clock = value.split(" ")
        return (
            f"<{prefix}Date>{day}</{prefix}Date>"
            f"<{prefix}Time>{clock}</{prefix}Time>"
        )

    period_day, period_clock = period.split(" ")
    business = f"<BusinessDate>{business_date}</BusinessDate>"
    return (
        _sale(business_date=business_date, **sale)
        .replace(
            "<BeginDate>2024-10-13</BeginDate>",
            f"<BeginDate>{period_day}</BeginDate>"
            f"<BeginTime>{period_clock}</BeginTime>"
            "<EndDate>2100-01-01</EndDate><EndTime>00:00:00</EndTime>",
        )
        .replace(
            business,
            stamp("EventStart", start) + stamp("EventEnd", end)
            + business + stamp("Receipt", receipt),
        )
    )


def test_parser_event_hour_sources():
    from api.Modules.PosImport.Services.naxml import parse_pjr

    # The event's own start wins.
    ev = parse_pjr(_sale(event_dt="2024-10-14T13:45:12"))
    assert ev.event_hour == 13
    assert ev.started_at.isoformat() == "2024-10-14T13:45:12"

    # No timestamp anywhere → None (chart mutes, totals intact).
    assert parse_pjr(_sale()).event_hour is None


def test_event_hour_is_the_event_start_not_the_report_period():
    """The real-file bug: the header says 22:51:54 (the day close
    that opened this business day) on every file, the sale was rung
    at 07:35 the next morning."""
    from api.Modules.PosImport.Services.naxml import parse_pjr

    ev = parse_pjr(_passport(
        "2024-10-17 07:35:54", end="2024-10-17 07:36:09",
        receipt="2024-10-17 07:36:09",
    ))
    assert ev.event_hour == 7
    assert ev.business_date.isoformat() == "2024-10-16"

    # A ticket that runs past the top of the hour stays in the hour
    # the cashier began it.
    ev = parse_pjr(_passport(
        "2024-10-17 13:59:40", end="2024-10-17 14:00:25",
        receipt="2024-10-17 14:00:25",
    ))
    assert ev.event_hour == 13


def test_event_hour_falls_back_to_the_end_never_receipt_or_period():
    """An event's time is its EventStart / EventEnd date and time
    only (the owner's rule)."""
    from api.Modules.PosImport.Services.naxml import parse_pjr

    # No start → the end, even when a receipt time is there.
    assert parse_pjr(_passport(
        end="2024-10-17 09:05:00", receipt="2024-10-17 08:59:59",
    )).event_hour == 9
    # A receipt alone is not the event's time → no hour.
    assert parse_pjr(_passport(
        receipt="2024-10-17 08:59:59",
    )).event_hour is None
    # A malformed start time falls through, it does not fail the parse.
    assert parse_pjr(_passport(
        "2024-10-17 7h35", end="2024-10-17 10:01:00",
    )).event_hour == 10
    # A start date without its time is not midnight.
    doc = _passport(
        "2024-10-17 07:35:54", end="2024-10-17 11:20:00",
    ).replace("<EventStartTime>07:35:54</EventStartTime>", "")
    assert parse_pjr(doc).event_hour == 11
    # Only the header's period stamp → no hour, not 22.
    ev = parse_pjr(_passport())
    assert ev.event_hour is None
    assert ev.net_cents == 324  # the sale itself still parses


def test_real_shaped_files_bucket_by_their_own_hour(client, test_store_id):
    """Every file of the day carries the same period header
    (22:51:54); the buckets follow each sale's own start, live and
    when the commit rebuilds them from the staged originals."""
    from api.Modules.DayClose.Models import HourlySale

    h = _admin(client, test_store_id)
    key = _issue_key(client, h)["key"]
    dept = _mk_department(client, h, "Misc H2")
    _map_codes(client, h, {"17": dept["id"]})

    day = "2025-01-10"
    period = f"{day} 22:51:54"
    for name, start in [
        ("H2-001.xml", f"{day} 23:10:00"),   # the day opens at night
        ("H2-002.xml", "2025-01-11 07:35:54"),
        ("H2-003.xml", "2025-01-11 07:50:00"),
        ("H2-004.xml", "2025-01-11 16:20:00"),
    ]:
        resp = _agent_upload(client, key, name, _passport(
            start, end=start, receipt=start, business_date=day,
            period=period,
        ))
        assert resp.status_code == 200, resp.text
    expected = {23: 299, 7: 598, 16: 299}
    assert _buckets(test_store_id, day) == expected

    # Drop the live preview: the commit must rebuild the same shape
    # from the staged files alone.
    with db_session():
        db.session.query(HourlySale).filter_by(
            store_id=test_store_id,
        ).delete()
        db.session.commit()
    resp = client.post(
        "/api/v2/posimport/staged/commit", headers=h, json={"day": day},
    )
    assert resp.status_code == 200, resp.text
    assert _buckets(test_store_id, day) == expected


def test_staging_increments_and_commit_rebuilds(client, test_store_id):
    h = _admin(client, test_store_id)
    key = _issue_key(client, h)["key"]
    dept = _mk_department(client, h, "Misc H1")
    _map_codes(client, h, {"17": dept["id"]})

    # Two sales in hour 13, one in hour 20 — buckets sum live.
    _agent_upload(client, key, "H1-001.xml", _sale(
        business_date="2025-01-10", event_dt="2025-01-10T13:05:00",
    ))
    _agent_upload(client, key, "H1-002.xml", _sale(
        business_date="2025-01-10", event_dt="2025-01-10T13:40:00",
    ))
    _agent_upload(client, key, "H1-003.xml", _sale(
        business_date="2025-01-10", event_dt="2025-01-10T20:01:00",
    ))
    # Duplicate filename → no double count.
    _agent_upload(client, key, "H1-001.xml", _sale(
        business_date="2025-01-10", event_dt="2025-01-10T13:05:00",
    ))
    # net_cents is pre-tax sales (2.99/event) — same basis as
    # the booked gross_sales.
    assert _buckets(test_store_id, "2025-01-10") == {
        13: 598, 20: 299,
    }

    # Day rolls (G-1 auto-commit fires) → rebuild produces the
    # same buckets — idempotent with the live increments.
    _agent_upload(client, key, "H1-D2-001.xml", _sale(
        business_date="2025-01-11", event_dt="2025-01-11T06:00:00",
    ))
    assert _buckets(test_store_id, "2025-01-10") == {
        13: 598, 20: 299,
    }

    # Manual re-commit also rebuilds, not doubles.
    resp = client.post(
        "/api/v2/posimport/staged/commit", headers=h,
        json={"day": "2025-01-10"},
    )
    assert resp.status_code == 200, resp.text
    assert _buckets(test_store_id, "2025-01-10") == {
        13: 598, 20: 299,
    }


def test_dashboard_hourly_block(client, test_store_id):
    from datetime import date, timedelta

    from api.Modules.DayClose.Models import HourlySale
    from api.Modules.Tenancy.Models import Store
    from tests.conftest import login_admin

    with db_session():
        db.session.get(Store, test_store_id).business_type = "cstore"
        today = date.today()
        for day, hour, cents in [
            (today, 9, 500_00),
            (today, 17, 900_00),
            (today - timedelta(days=1), 9, 400_00),
        ]:
            db.session.add(HourlySale(
                store_id=test_store_id, report_date=day, hour=hour,
                amount_cents=cents,
            ))
        db.session.commit()

    token = login_admin(client, test_store_id)
    sales = client.get(
        "/api/v2/dashboard/summary",
        headers=_headers(token),
    ).json()["sales"]
    hourly = sales["hourly"]
    assert hourly is not None
    assert hourly["current_date"] == date.today().isoformat()
    assert hourly["current"][9] == 500.0
    assert hourly["current"][17] == 900.0
    assert hourly["current_total"] == 1400.0
    assert hourly["previous"][9] == 400.0
    assert hourly["previous_total"] == 400.0


# ── Item movement (G-2) ─────────────────────────────────────


def test_item_movement_rebuild_and_report(client, test_store_id):
    """Committing a day builds per-item movement rows; the report
    endpoint aggregates a range, top dollars first, and flags
    codes missing from the price book."""
    h = _admin(client, test_store_id)
    key = _issue_key(client, h)["key"]
    dept = _mk_department(client, h, "Misc M1")
    _map_codes(client, h, {"17": dept["id"]})

    # Two sales of the same item (POSCode 2, $2.99) on one day.
    _agent_upload(client, key, "M1-001.xml", _sale(
        business_date="2025-02-01", event_dt="2025-02-01T10:00:00",
    ))
    _agent_upload(client, key, "M1-002.xml", _sale(
        business_date="2025-02-01", event_dt="2025-02-01T11:00:00",
    ))
    # Day rolls → auto-commit books it (movement rebuilds too).
    _agent_upload(client, key, "M1-D2-001.xml", _sale(
        business_date="2025-02-02", event_dt="2025-02-02T08:00:00",
    ))

    resp = client.get(
        "/api/v2/posimport/item-movement"
        "?start=2025-02-01&end=2025-02-01",
        headers=h,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 1
    row = body["rows"][0]
    assert row["pos_code"] == "2"
    assert row["description"] == "7lb ice bag"
    assert row["quantity"] == 2.0
    assert row["amount"] == 5.98
    assert row["avg_price"] == 2.99
    assert row["in_price_book"] is False
    assert body["total_amount"] == 5.98

    # Search matches description substring; misses return empty.
    hit = client.get(
        "/api/v2/posimport/item-movement"
        "?start=2025-02-01&end=2025-02-01&q=ice",
        headers=h,
    ).json()
    assert hit["total"] == 1
    miss = client.get(
        "/api/v2/posimport/item-movement"
        "?start=2025-02-01&end=2025-02-01&q=zzz",
        headers=h,
    ).json()
    assert miss["total"] == 0

    # Once the code exists in the price book, the flag flips.
    created = client.post(
        "/api/v2/catalog/items", headers=h,
        json={"pos_code": "2", "name": "7lb ice bag", "price": 2.99},
    )
    assert created.status_code == 201, created.text
    body = client.get(
        "/api/v2/posimport/item-movement"
        "?start=2025-02-01&end=2025-02-01",
        headers=h,
    ).json()
    assert body["rows"][0]["in_price_book"] is True


# ── NAXML price-book export (G-4, beta) ─────────────────────


def test_pricebook_export_shape_and_filters(client, test_store_id):
    """The export carries every active item as an ITTData record
    (POSCode + format, 40-char description, sell price, reverse-
    mapped merchandise code, ActiveFlag); changed_since filters;
    an empty selection 422s instead of shipping a blank file."""
    from defusedxml import ElementTree as SafeET

    h = _admin(client, test_store_id)
    dept = _mk_department(client, h, "Snacks G4")
    _map_codes(client, h, {"41": dept["id"]})

    made = client.post(
        "/api/v2/catalog/items", headers=h,
        json={
            "pos_code": "049000042566", "name": "Coke 20oz",
            "price": 2.79, "department_id": dept["id"],
        },
    )
    assert made.status_code == 201, made.text
    client.post(
        "/api/v2/catalog/items", headers=h,
        json={
            "pos_code": "7", "name": "Fountain drink",
            "pos_code_format": "plu", "price": 1.29,
        },
    )

    resp = client.get(
        "/api/v2/posimport/naxml/pricebook-export", headers=h,
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    assert resp.headers["Content-Disposition"].startswith("attachment")
    root = SafeET.fromstring(resp.get_data(as_text=True))
    assert root.tag == "NAXML-MaintenanceRequest"
    assert root.find(".//VendorName").text == "DineroBook"

    records = {
        r.find(".//POSCode").text: r
        for r in root.findall(".//ITTData")
    }
    coke = records["049000042566"]
    assert coke.find(".//POSCodeFormat").get("format") == "upcA"
    assert coke.find(".//Description").text == "Coke 20oz"
    assert coke.find(".//RegularSellPrice").text == "2.79"
    # Reverse-mapped from the department's merchandise code.
    assert coke.find(".//MerchandiseCode").text == "41"
    assert coke.find(".//ActiveFlag").get("value") == "yes"

    plu = records["7"]
    assert plu.find(".//POSCodeFormat").get("format") == "plu"
    assert plu.find(".//MerchandiseCode") is None

    # A future changed_since date matches nothing → 422, no file.
    empty = client.get(
        "/api/v2/posimport/naxml/pricebook-export"
        "?changed_since=2099-01-01",
        headers=h,
    )
    assert empty.status_code == 422

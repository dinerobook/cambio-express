"""Movement reports through the site agent (G-7).

Under test:

  * a movement upload is staged (``event_kind="movement"``, its
    business day, no error) and its rows land in the family table
    with the header, the store and the file name,
  * a re-sent report replaces its rows — same filename is a
    duplicate, a new filename for the same report never doubles,
    another period or another start time is another report,
  * TPM is accepted and stores nothing,
  * an unreadable movement report is staged with its error under its
    day, and blocks nothing,
  * journal readers never see movement files: staged-day counts and
    errors, auto-commit, commit and the price-book harvest behave
    exactly as without them,
  * rows are per store, and purged with the store.
"""
import base64
from datetime import date, time, timedelta

import pytest

from api.Core.Clock import utc_now
from api.Modules.PosImport.Models import (
    PosFuelGradeMovement,
    PosItemSalesMovement,
    PosJournalFile,
    PosMerchandiseCodeMovement,
    PosMiscSummaryMovement,
    PosTaxLevelMovement,
)
from api.Modules.PosImport.Services import stage_journal_file
from api.Modules.PosImport.Services.movement_ingest import FAMILY_MODELS
from tests._app import db, db_session
from tests.Modules.PosImport.movement_fixtures import (
    ALL_FAMILIES, fgm, ism, mcm, movement_doc, msm, tlm, tpm,
)
from tests.Modules.PosImport.test_agent import (
    _admin, _agent_upload, _issue_key,
)
from tests.Modules.PosImport.test_ingest import _map_codes, _mk_department
from tests.Modules.PosImport.test_naxml import _sale


def _count(model, **filters):
    with db_session():
        return db.session.query(model).filter_by(**filters).count()


def _staged(filename):
    with db_session():
        return db.session.query(PosJournalFile).filter_by(
            filename=filename,
        ).one()


@pytest.fixture
def agent_key(client, test_store_id):
    return _issue_key(client, _admin(client, test_store_id))["key"]


def test_each_family_is_staged_and_stored(client, test_store_id, agent_key):
    expected_rows = {"FGM": 5, "ISM": 3, "MCM": 2, "MSM": 9, "TLM": 2}
    for family, build in ALL_FAMILIES.items():
        name = f"{family}990251205235945000001.xml"
        body = _agent_upload(client, agent_key, name, build()).json()
        assert body == {
            "staged": True, "duplicate": False,
            "business_date": "2025-12-05", "parse_error": "",
        }
        staged = _staged(name)
        assert staged.event_kind == "movement"
        assert staged.business_date == date(2025, 12, 5)
        assert staged.parse_error == ""
    for family, model in FAMILY_MODELS.items():
        assert _count(model, store_id=test_store_id) == expected_rows[family]

    with db_session():
        row = db.session.query(PosTaxLevelMovement).filter_by(
            tax_level_id="99",
        ).one()
        assert row.source_file == "TLM990251205235945000001.xml"
        assert row.business_date == date(2025, 12, 5)
        assert row.begin_date == date(2025, 12, 5)
        assert row.begin_time == time(23, 59, 45)
        assert row.end_date == date(2025, 12, 6)
        assert row.end_time == time(23, 59, 18)
        assert row.primary_report_period == 2
        assert row.secondary_report_period == 0
        assert row.report_sequence_number == 1
        assert row.detail_seq == 1
        assert row.tax_collected_amount_cents == 12543
        seqs = [
            r.detail_seq for r in db.session.query(PosMiscSummaryMovement)
            .order_by(PosMiscSummaryMovement.detail_seq)
        ]
        assert seqs == list(range(1, 10))


def test_tpm_is_accepted_and_stores_nothing(client, test_store_id, agent_key):
    body = _agent_upload(client, agent_key, "TPM1.xml", tpm()).json()
    assert body["staged"] is True
    assert body["parse_error"] == ""
    assert _staged("TPM1.xml").event_kind == "movement"
    for model in FAMILY_MODELS.values():
        assert _count(model) == 0


def test_resending_a_report_replaces_it(client, test_store_id, agent_key):
    _agent_upload(client, agent_key, "FGM-a.xml", fgm())
    assert _count(PosFuelGradeMovement) == 5

    # Same file again: the agent's retry — a duplicate, untouched.
    body = _agent_upload(client, agent_key, "FGM-a.xml", fgm()).json()
    assert body["duplicate"] is True
    assert _count(PosFuelGradeMovement) == 5

    # The same report regenerated under a new name (Passport re-run):
    # its rows replace the first copy's instead of doubling them.
    edited = fgm().replace(
        "<FuelGradeSalesAmount>40.12</FuelGradeSalesAmount>",
        "<FuelGradeSalesAmount>90.00</FuelGradeSalesAmount>",
    )
    _agent_upload(client, agent_key, "FGM-b.xml", edited)
    with db_session():
        rows = db.session.query(PosFuelGradeMovement).all()
        assert len(rows) == 5
        assert {r.source_file for r in rows} == {"FGM-b.xml"}
        assert sum(r.sales_amount_cents for r in rows) == (
            9000 + 6175 + 1575 + 250 + 3512
        )


def test_a_report_with_fewer_rows_leaves_none_of_the_old(
    client, test_store_id, agent_key,
):
    _agent_upload(client, agent_key, "MSM-a.xml", msm())
    assert _count(PosMiscSummaryMovement) == 9
    # The same report re-sent with no details at all.
    _agent_upload(client, agent_key, "MSM-b.xml", movement_doc("MSM", ""))
    assert _count(PosMiscSummaryMovement) == 0


def test_other_periods_days_and_start_times_are_other_reports(
    client, test_store_id, agent_key,
):
    _agent_upload(client, agent_key, "MCM-day.xml", mcm())
    # A shift report starting the moment the day starts.
    _agent_upload(client, agent_key, "MCM-shift.xml", mcm(primary_period="1"))
    # A second day report the same business day, later start.
    _agent_upload(client, agent_key, "MCM-late.xml", mcm(begin_time="12:00:00"))
    # The next business day.
    _agent_upload(client, agent_key, "MCM-next.xml", mcm(
        business_date="2025-12-06", begin_time="23:59:19",
    ))
    assert _count(PosMerchandiseCodeMovement) == 8
    assert _count(PosMerchandiseCodeMovement, primary_report_period=1) == 2
    assert _count(
        PosMerchandiseCodeMovement, business_date=date(2025, 12, 6),
    ) == 2


def test_an_unreadable_report_is_staged_under_its_day(
    client, test_store_id, agent_key,
):
    bad = ism().replace("<SalesAmount>7.47</SalesAmount>",
                        "<SalesAmount>lots</SalesAmount>")
    body = _agent_upload(client, agent_key, "ISM-bad.xml", bad).json()
    assert body["staged"] is True
    assert body["business_date"] == "2025-12-05"
    assert "ISM" in body["parse_error"]
    staged = _staged("ISM-bad.xml")
    assert staged.event_kind == "movement"
    assert _count(PosItemSalesMovement) == 0

    # No header → no day, still staged with the reason.
    body = _agent_upload(client, agent_key, "ISM-nohdr.xml", ism().replace(
        "<BusinessDate>2025-12-05</BusinessDate>", "",
    )).json()
    assert body["business_date"] is None
    assert body["parse_error"] != ""


def test_journal_files_still_route_to_the_journal_parser(
    client, test_store_id, agent_key,
):
    body = _agent_upload(client, agent_key, "PJR1.xml", _sale()).json()
    assert body["business_date"] == "2024-10-14"
    assert _staged("PJR1.xml").event_kind == "sale"
    body = _agent_upload(client, agent_key, "PJR2.xml", "garbage").json()
    assert body["parse_error"] == "Not well-formed XML."
    assert _staged("PJR2.xml").event_kind == ""


def test_staged_days_count_journal_files_and_reports_apart(
    client, test_store_id, agent_key,
):
    h = _admin(client, test_store_id)
    _agent_upload(client, agent_key, "PJR1.xml", _sale(business_date="2025-12-05"))
    for family, build in ALL_FAMILIES.items():
        _agent_upload(client, agent_key, f"{family}1.xml", build())
    _agent_upload(client, agent_key, "MCM-bad.xml", mcm().replace(
        "<SalesAmount>8.46</SalesAmount>", "<SalesAmount>x</SalesAmount>",
    ))
    days = client.get("/api/v2/posimport/staged", headers=h).json()["days"]
    assert days == [{
        "business_date": "2025-12-05", "file_count": 1, "error_count": 0,
        "committed": False, "report_count": 7,
    }]


def test_reports_never_trigger_or_block_auto_commit(
    client, test_store_id, agent_key,
):
    h = _admin(client, test_store_id)
    misc = _mk_department(client, h, "Misc G7")
    _map_codes(client, h, {"17": misc["id"]})
    _agent_upload(client, agent_key, "PJR-d1.xml", _sale(business_date="2025-12-05"))
    # The day's reports — one of them unreadable — and a report dated
    # the NEXT day: none of them is the "day rolled" signal, and the
    # bad one does not hold the day back once it really rolls.
    _agent_upload(client, agent_key, "MCM-d1.xml", mcm())
    _agent_upload(client, agent_key, "ISM-d1.xml", ism().replace(
        "<SalesAmount>7.47</SalesAmount>", "<SalesAmount>x</SalesAmount>",
    ))
    _agent_upload(client, agent_key, "TLM-d2.xml", tlm(business_date="2025-12-06"))
    day = client.get("/api/v2/dayclose/day/2025-12-05", headers=h).json()
    assert day["closes"] == []

    _agent_upload(client, agent_key, "PJR-d2.xml", _sale(business_date="2025-12-06"))
    day = client.get("/api/v2/dayclose/day/2025-12-05", headers=h).json()
    assert len(day["closes"]) == 1
    assert day["closes"][0]["gross_sales"] == pytest.approx(2.99)


def test_commit_reads_only_journal_files(client, test_store_id, agent_key):
    h = _admin(client, test_store_id)
    misc = _mk_department(client, h, "Misc G7c")
    _map_codes(client, h, {"17": misc["id"]})
    _agent_upload(client, agent_key, "PJR-c.xml", _sale(business_date="2025-12-05"))
    for family, build in ALL_FAMILIES.items():
        _agent_upload(client, agent_key, f"{family}-c.xml", build())
    resp = client.post(
        "/api/v2/posimport/staged/commit", headers=h,
        json={"day": "2025-12-05"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["closes_written"] == 1
    day = client.get("/api/v2/dayclose/day/2025-12-05", headers=h).json()
    assert day["closes"][0]["gross_sales"] == pytest.approx(2.99)
    # The movement rows are still there, untouched by the commit.
    assert _count(PosMerchandiseCodeMovement) == 2


def test_price_book_harvest_skips_reports(client, test_store_id, agent_key):
    h = _admin(client, test_store_id)
    _agent_upload(client, agent_key, "ISM-p.xml", ism())
    resp = client.get("/api/v2/posimport/pricebook/preview", headers=h)
    assert resp.status_code == 200
    assert resp.json()["items"] == []


def test_rows_belong_to_the_uploading_store(client, test_store_id, agent_key):
    from api.Modules.Tenancy.Models import Store
    with db_session():
        other = Store(name="Other", slug="other-g7", email="o@test.com",
                      plan="trial")
        db.session.add(other)
        db.session.commit()
        other_id = other.id
        stage_journal_file(
            db.session, other_id, filename="TLM-other.xml",
            content=tlm().encode("ISO-8859-1"),
        )
        db.session.commit()
    _agent_upload(client, agent_key, "TLM-mine.xml", tlm())
    # Same report key in two stores: each keeps its own copy.
    assert _count(PosTaxLevelMovement, store_id=test_store_id) == 2
    assert _count(PosTaxLevelMovement, store_id=other_id) == 2


def test_movement_rows_are_purged_with_the_store(client):
    from api.Modules.Tenancy.Models import Store
    from tests._app import purge_expired_stores
    with db_session():
        s = Store(name="Gone", slug="gone-g7", email="g@test.com",
                  plan="inactive", canceled_at=utc_now() - timedelta(days=181),
                  data_retention_until=utc_now() - timedelta(days=1))
        db.session.add(s)
        db.session.commit()
        sid = s.id
        for family, build in ALL_FAMILIES.items():
            stage_journal_file(
                db.session, sid, filename=f"{family}-gone.xml",
                content=build().encode("ISO-8859-1"),
            )
        db.session.commit()
        for model in FAMILY_MODELS.values():
            assert db.session.query(model).filter_by(store_id=sid).count() > 0
        assert purge_expired_stores() == 1
        db.session.expire_all()
        for model in (*FAMILY_MODELS.values(), PosJournalFile):
            assert db.session.query(model).filter_by(store_id=sid).count() == 0


def test_a_report_is_known_by_its_basename(client, test_store_id, agent_key):
    raw = base64.b64encode(mcm().encode("ISO-8859-1")).decode()
    resp = client.post(
        "/api/v2/posimport/agent/upload",
        headers={"X-Agent-Key": agent_key},
        json={"filename": "C:\\Passport\\BOOutbox\\MCM9.xml",
              "content_base64": raw},
    )
    assert resp.status_code == 200
    with db_session():
        rows = db.session.query(PosMerchandiseCodeMovement).all()
        assert {r.source_file for r in rows} == {"MCM9.xml"}

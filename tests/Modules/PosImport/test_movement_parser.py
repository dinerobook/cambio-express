"""Gilbarco movement report parser (G-7).

Fixtures are synthetic (``movement_fixtures``) with the element
structure of a live Passport 23.01 export. Under test:

  * each family's rows and column values, money in cents,
  * FGM: one row per price tier, the position's meter repeated on
    each (never split or summed),
  * ISM: one row per sell price; money without a leading zero,
  * MSM: an absent modifier is None (a subtotal), present is a string,
  * TPM: header only, no rows,
  * the header is required (it is the replace key),
  * routing: anything that is not a movement report returns None so
    the journal parser takes it; a namespaced document still parses;
    hostile XML never parses.
"""
from datetime import date, time

import pytest

from api.Modules.PosImport.Services.movement import (
    MovementParseError,
    parse_movement_report,
)
from tests.Modules.PosImport.movement_fixtures import (
    fgm, ism, mcm, movement_doc, msm, tlm, tpm,
)
from tests.Modules.PosImport.test_naxml import _sale


def test_header_is_read_from_every_family():
    for build in (fgm, ism, mcm, msm, tlm, tpm):
        report = parse_movement_report(build())
        assert report is not None
        h = report.header
        assert h.business_date == date(2025, 12, 5)
        assert h.begin_date == date(2025, 12, 5)
        assert h.begin_time == time(23, 59, 45)
        assert h.end_date == date(2025, 12, 6)
        assert h.end_time == time(23, 59, 18)
        assert (h.primary_report_period, h.secondary_report_period) == (2, 0)
        assert h.report_sequence_number == 1


def test_fgm_one_row_per_tier_with_the_position_meter_repeated():
    report = parse_movement_report(fgm())
    assert report is not None and report.family == "FGM"
    rows = report.rows
    assert len(rows) == 5
    pump1 = [r for r in rows if r["fuel_grade_id"] == "001"
             and r["fuel_position_id"] == "1"]
    assert [r["price_tier_code"] for r in pump1] == ["0001", "0002"]
    # The meter belongs to the position: the same reading on both tiers.
    assert {r["non_resettable_total_volume"] for r in pump1} == {41250.25}
    assert {r["non_resettable_total_amount_cents"] for r in pump1} == {9876040}
    assert pump1[0]["sales_volume"] == pytest.approx(12.345)
    assert pump1[0]["sales_amount_cents"] == 4012
    assert pump1[1]["sales_amount_cents"] == 6175
    assert pump1[1]["discount_amount_cents"] == 125
    assert pump1[1]["discount_count"] == 1
    assert pump1[0]["pump_test_amount_cents"] == 0
    assert "return_tank_id" not in pump1[0]


def test_fgm_position_without_tiers_keeps_its_meter():
    body = """<FGMDetail><FuelGradeID>003</FuelGradeID>
<FGMPositionSummary><FuelPositionID>4</FuelPositionID>
<FGMNonResettableTotal>
<FuelGradeNonResettableTotalVolume>12.5</FuelGradeNonResettableTotalVolume>
<FuelGradeNonResettableTotalAmount>40</FuelGradeNonResettableTotalAmount>
</FGMNonResettableTotal></FGMPositionSummary></FGMDetail>"""
    report = parse_movement_report(movement_doc("FGM", body))
    assert report is not None
    [row] = report.rows
    assert row["fuel_position_id"] == "4"
    assert row["price_tier_code"] == ""
    assert row["non_resettable_total_amount_cents"] == 4000
    assert row["sales_amount_cents"] == 0


def test_ism_one_row_per_sell_price_and_leading_dot_money():
    report = parse_movement_report(ism())
    assert report is not None and report.family == "ISM"
    cola = [r for r in report.rows if r["pos_code"] == "012345678905"]
    assert [r["actual_sales_price_cents"] for r in cola] == [249, 99]
    assert [r["sales_amount_cents"] for r in cola] == [747, 99]
    assert cola[1]["promotion_amount_cents"] == -99
    assert cola[1]["promotion_count"] == 1
    assert cola[0]["pos_code_format"] == "upcA"
    assert cola[0]["pos_code_modifier"] == "0"
    assert cola[0]["item_id"] == "012345678905"
    assert cola[0]["description"] == "COLA 20OZ"
    assert cola[0]["merchandise_code"] == "10"
    banana = [r for r in report.rows if r["pos_code"] == "4011"]
    assert banana[0]["pos_code_format"] == "plu"
    assert banana[0]["selling_units"] == "6"
    assert banana[0]["sales_quantity"] == 6.0


def test_mcm_department_totals():
    report = parse_movement_report(mcm())
    assert report is not None
    soda, lottery = report.rows
    assert soda["merchandise_code"] == "10"
    assert soda["description"] == "SODA"
    assert soda["sales_amount_cents"] == 846
    assert soda["transaction_count"] == 3
    assert soda["promotion_amount_cents"] == -99
    assert soda["open_dept_sales_amount_cents"] == -150
    assert soda["open_dept_transaction_count"] == 2
    assert lottery["merchandise_code"] == "1024"
    assert lottery["refund_amount_cents"] == -500
    assert lottery["refund_count"] == 1


def test_msm_modifier_absent_is_none_present_is_text():
    report = parse_movement_report(msm())
    assert report is not None
    rows = report.rows
    assert len(rows) == 9
    assert rows[0]["summary_code"] == "safeDrop"
    assert rows[0]["tender_code"] == "cash"
    assert rows[0]["tender_sub_code"] == "generic"
    assert rows[0]["summary_amount_cents"] == 80000
    payouts = [r for r in rows if r["summary_code"] == "payouts"]
    assert [r["summary_sub_code_modifier"] for r in payouts] == [
        None, None, "3", "3", "3",
    ]
    # Fuel rows carry gallons in the count.
    assert rows[-1]["summary_count"] == pytest.approx(12.345)


def test_tlm_tax_levels():
    report = parse_movement_report(tlm())
    assert report is not None
    level99, level101 = report.rows
    assert level99["tax_level_id"] == "99"
    assert level99["merchandise_code"] == "0"
    assert level99["taxable_sales_amount_cents"] == 152033
    assert level99["tax_collected_amount_cents"] == 12543
    assert level99["tax_forgiven_sales_cents"] == 310
    assert level101["tax_collected_amount_cents"] == 1650


def test_tpm_is_accepted_with_no_rows():
    report = parse_movement_report(tpm())
    assert report is not None
    assert report.family == "TPM"
    assert report.rows == []


def test_a_namespaced_report_parses_the_same():
    doc = fgm().replace(
        '<NAXML-MovementReport version="3.4">',
        '<NAXML-MovementReport xmlns="http://www.naxml.org/POSBO/Vocabulary/2003-10-16" version="3.4">',
    )
    report = parse_movement_report(doc)
    assert report is not None
    assert len(report.rows) == 5


def test_non_movement_documents_are_left_to_the_journal_parser():
    assert parse_movement_report(_sale()) is None
    assert parse_movement_report("not xml") is None
    assert parse_movement_report(b"") is None


def test_hostile_xml_never_parses():
    bomb = """<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>
<NAXML-MovementReport><TankProductMovement>&lol2;</TankProductMovement>
</NAXML-MovementReport>"""
    assert parse_movement_report(bomb) is None
    xxe = """<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>
<NAXML-MovementReport><TankProductMovement>&x;</TankProductMovement>
</NAXML-MovementReport>"""
    assert parse_movement_report(xxe) is None


@pytest.mark.parametrize("missing", ["BusinessDate", "BeginDate", "BeginTime"])
def test_the_report_key_is_required(missing):
    doc = tlm().replace(f"<{missing}>", f"<X{missing}>").replace(
        f"</{missing}>", f"</X{missing}>",
    )
    with pytest.raises(MovementParseError) as exc:
        parse_movement_report(doc)
    assert exc.value.family == "TLM"
    assert exc.value.business_date is None


def test_a_report_without_a_header_is_refused():
    with pytest.raises(MovementParseError):
        parse_movement_report(movement_doc("MCM", "", header=""))


def test_a_bad_value_keeps_the_day_for_the_staged_file():
    doc = mcm().replace("<SalesAmount>8.46</SalesAmount>",
                        "<SalesAmount>eight</SalesAmount>")
    with pytest.raises(MovementParseError) as exc:
        parse_movement_report(doc)
    assert "MCM" in str(exc.value)
    assert exc.value.business_date == date(2025, 12, 5)


def test_an_unknown_family_is_refused_not_ignored():
    doc = """<NAXML-MovementReport version="3.4">
<TransmissionHeader/><FuelProductMovement/></NAXML-MovementReport>"""
    with pytest.raises(MovementParseError) as exc:
        parse_movement_report(doc)
    assert "FuelProductMovement" in str(exc.value)

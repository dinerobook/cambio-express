"""The register's day close on the store daily book.

``register_day`` turns a business day's reports (TLM / MCM / FGM /
MSM rows in PosImport's movement tables) into daily book lines;
``pull_register_day`` and ``POST /storebook/{day}/register`` take
them onto the sheet. The figures below are invented, in the shapes
three real days had: every sales line adds up to the register's
payment types plus the lottery paid out, to the cent.
"""
from datetime import date, time

import pytest

from api.Modules.DayClose.Models import Department
from api.Modules.PosImport.Models import (
    PosFuelGradeMovement,
    PosMerchandiseCodeMovement,
    PosMerchandiseMap,
    PosMiscSummaryMovement,
    PosTaxLevelMovement,
)
from api.Modules.StoreBook.Models import FIELD_COLUMN
from api.Modules.StoreBook.Services import (
    DayLockedError, get_or_create_entry, originals_for, set_lock,
    update_entry,
)
from api.Modules.StoreBook.Services.register_day import (
    PROBLEM_DEPARTMENTS, PROBLEM_TAX_SPLIT, PROBLEM_WAITING,
    REGISTER_DAY_FLAG, RegisterDayNotReady, is_pending,
    pull_register_day, register_day, register_day_enabled,
)
from tests._app import db, db_session
from tests.conftest import login_admin

DAY = date(2026, 9, 14)
DAY_ISO = DAY.isoformat()

# number → (name, type, sales cents, quantity). 38 is set up but sold
# nothing today, so the register's department report leaves it out.
DEPARTMENTS = {
    "1": ("Taxable Items", "merchandise", 50_000, 31),
    "2": ("Non-Taxable", "merchandise", 4_000, 9),
    "3": ("Lottery Paid In", "lottery_sell", 30_000, 20),
    "6": ("Lottery Paid Out", "lottery_cash", -12_000, 7),
    "36": ("Lotto Paid In", "lotto_sell", 8_000, 8),
    "37": ("Lotto Paid Out", "lotto_cash", -500, 1),
    "4": ("Money Order", "money_order", 40_000, 2),
    "7": ("Money Order Fee", "money_order_fee", 300, 2),
    "39": ("Money Transfer", "money_transfer", 25_000, 1),
    "41": ("Money Trans Fee", "money_transfer_fee", 900, 1),
    "38": ("Check Cash", "check_cash_fee", None, 0),
    "1024": ("Fuel 1", "fuel", 60_000, 40),
}
# tax level → (sales, tax collected). 101 is the taxed one; its sales
# are $3.00 under department 1 because the tax report takes a refund
# off and the department report does not.
TAX_LEVELS = {
    "99": (60_000, 0),      # fuel
    "101": (49_700, 4_100),  # taxed goods
    "102": (66_200, 0),     # money orders, transfers and their fees
    "103": (25_500, 0),     # lottery, net of what was paid out
    "104": (4_000, 0),      # non-taxed goods
}
PAYMENT_TYPES = {
    "1": 100_000, "3": 30_000, "4": 25_000, "8": 500,
    "202": 34_000, "203": 20_000,
}

EXPECTED = {
    "taxable_sales": 49_700,
    "non_taxable_sales": 4_000,
    "sales_tax": 4_100,
    "fuel_amount": 60_000,
    "lottery_sales": 30_000,
    "lotto_sales": 8_000,
    "lotto_paid_out": 12_500,
    "money_order": 40_000,
    "money_order_fee": 300,
    "money_transfer": 25_000,
    "money_transfer_fee": 900,
    "check_fees": 0,
    "paid_out_purchases": 20_000,
    "cards": 55_000,
    "gas_pos_cards": 54_000,
}


def _store(slug):
    from api.Modules.Tenancy.Models import Store
    s = Store(name=slug, slug=slug, email=f"{slug}@x.com", plan="basic")
    db.session.add(s)
    db.session.commit()
    return s.id


def _header(store_id, seq, *, day=DAY, begin=time(23, 59, 45)):
    return dict(
        store_id=store_id, source_file="report.xml",
        report_sequence_number=1, primary_report_period=2,
        secondary_report_period=0, business_date=day,
        begin_date=day, begin_time=begin,
        end_date=date(day.year, day.month, day.day + 1),
        end_time=time(23, 59, 18), detail_seq=seq,
    )


def _setup_departments(store_id, *, skip=()):
    for number, (name, kind, _cents, _qty) in DEPARTMENTS.items():
        if number in skip:
            continue
        dept = Department(store_id=store_id, name=name, department_type=kind)
        db.session.add(dept)
        db.session.flush()
        db.session.add(PosMerchandiseMap(
            store_id=store_id, merchandise_code=number,
            department_id=dept.id,
        ))


def _seed_reports(store_id, *, families=("TLM", "MCM", "MSM", "FGM"), **kw):
    """The day's reports as rows. ``kw`` reaches ``_header`` (another
    day, another report of the same day)."""
    if "TLM" in families:
        for seq, (level, (sales, tax)) in enumerate(TAX_LEVELS.items(), 1):
            db.session.add(PosTaxLevelMovement(
                **_header(store_id, seq, **kw), tax_level_id=level,
                merchandise_code="0", taxable_sales_amount_cents=sales,
                tax_collected_amount_cents=tax,
            ))
    if "MCM" in families:
        seq = 0
        for number, (name, _kind, cents, qty) in DEPARTMENTS.items():
            if cents is None:
                continue
            seq += 1
            db.session.add(PosMerchandiseCodeMovement(
                **_header(store_id, seq, **kw), merchandise_code=number,
                description=name, sales_amount_cents=cents,
                sales_quantity=float(qty), transaction_count=qty,
            ))
    if "FGM" in families:
        for seq, (volume, cents) in enumerate(
            ((150.5, 45_000), (49.5, 15_000)), 1,
        ):
            db.session.add(PosFuelGradeMovement(
                **_header(store_id, seq, **kw), fuel_grade_id="001",
                fuel_position_id=str(seq), price_tier_code="1",
                sales_volume=volume, sales_amount_cents=cents,
            ))
    if "MSM" in families:
        rows = [
            # The subtotal, its repeat under vendorPay, then the parts.
            ("payouts", "total", None, -20_000),
            ("payouts", "vendorPay", None, -20_000),
            ("payouts", "vendorPay", "3", -12_000),
            ("payouts", "vendorPay", "3", -8_000),
            ("totalizer", "sales", "sales", 205_400),
            ("totalizer", "sales", "outsideFuelSales", 54_000),
            # The register repeats some totalizer rows.
            ("totalizer", "sales", "mdseOnly", 145_400),
            ("totalizer", "sales", "mdseOnly", 145_400),
            ("safeLoan", "MOP", "1", 20_000),
        ] + [("sales", "MOP", code, cents) for code, cents in PAYMENT_TYPES.items()]
        for seq, (code, sub, modifier, cents) in enumerate(rows, 1):
            db.session.add(PosMiscSummaryMovement(
                **_header(store_id, seq, **kw), summary_code=code,
                summary_sub_code=sub, summary_sub_code_modifier=modifier,
                summary_amount_cents=cents,
            ))
    db.session.commit()


def _flag_on(store_id):
    from api.Modules.Billing.Models import StoreFeatureOverride
    db.session.add(StoreFeatureOverride(
        store_id=store_id, flag_key=REGISTER_DAY_FLAG, enabled=True,
    ))
    db.session.commit()


# ── The figures ─────────────────────────────────────────────


def test_a_day_close_fills_every_register_line():
    with db_session():
        sid = _store("rd-full")
        _setup_departments(sid)
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        assert figures.ready and figures.problem == ""
        assert figures.values == EXPECTED
        assert figures.counts == {
            "money_order_count": 2.0, "money_transfer_count": 1.0,
            "fuel_gallons": 200.0,
        }
        assert figures.unmapped == []


def test_the_sales_lines_add_up_to_what_the_register_took():
    """Sales column = every payment type + the lottery paid out. If
    this breaks, a line is counted twice or dropped."""
    with db_session():
        sid = _store("rd-ties")
        _setup_departments(sid)
        _seed_reports(sid)
        values = register_day(db.session, sid, DAY).values
        sales = sum(v for k, v in values.items() if FIELD_COLUMN[k] == "sales")
        assert sales == sum(PAYMENT_TYPES.values()) + values["lotto_paid_out"]


def test_taxable_comes_from_the_tax_report_not_the_departments():
    """Department 1 sold $500.00 before a $3.00 refund; the tax report
    already took the refund off."""
    with db_session():
        sid = _store("rd-tax")
        _setup_departments(sid)
        _seed_reports(sid)
        assert register_day(db.session, sid, DAY).values["taxable_sales"] == 49_700


def test_payouts_are_read_once_not_subtotal_plus_parts():
    with db_session():
        sid = _store("rd-payouts")
        _setup_departments(sid)
        _seed_reports(sid)
        assert (
            register_day(db.session, sid, DAY).values["paid_out_purchases"]
            == 20_000
        )


def test_an_unknown_payment_type_is_reported_and_put_on_no_line():
    with db_session():
        sid = _store("rd-mop")
        _setup_departments(sid)
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        # 3 + 4 only: type 8 is not guessed into Cards.
        assert figures.values["cards"] == 55_000
        assert [
            (i.kind, i.code, i.amount_cents) for i in figures.unplaced
        ] == [("payment_type", "8", 500)]


def test_a_type_the_store_never_set_up_is_not_a_register_line():
    """No check cashing department at all: the register says nothing
    about check fees, so the line stays a hand-typed one. A department
    that only sold nothing today is still a $0.00 register line."""
    with db_session():
        sid = _store("rd-types")
        _setup_departments(sid, skip=("38",))
        _seed_reports(sid)
        assert "check_fees" not in register_day(db.session, sid, DAY).values
    with db_session():
        sid = _store("rd-types-zero")
        _setup_departments(sid)
        _seed_reports(sid)
        assert register_day(db.session, sid, DAY).values["check_fees"] == 0


def test_a_department_with_no_line_is_reported():
    with db_session():
        sid = _store("rd-service")
        _setup_departments(sid)
        dept = (
            db.session.query(Department)
            .filter_by(store_id=sid, name="Money Order Fee").one()
        )
        dept.department_type = "service"
        db.session.commit()
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        assert figures.ready
        assert "money_order_fee" not in figures.values
        assert [(i.kind, i.code, i.name, i.amount_cents) for i in figures.unplaced] == [
            ("department", "7", "Money Order Fee", 300),
            ("payment_type", "8", "", 500),
        ]
        # Still not merchandise: it stays out of Non tax.
        assert figures.values["non_taxable_sales"] == 4_000


def test_no_reports_means_no_register_data():
    with db_session():
        sid = _store("rd-none")
        figures = register_day(db.session, sid, DAY)
        assert not figures.has_data and not figures.ready
        assert figures.values == {}


def test_a_missing_report_waits_instead_of_half_filling():
    with db_session():
        sid = _store("rd-waiting")
        _setup_departments(sid)
        _seed_reports(sid, families=("TLM", "MCM"))
        figures = register_day(db.session, sid, DAY)
        assert figures.has_data and not figures.ready
        assert figures.problem == PROBLEM_WAITING
        assert figures.values == {}


def test_a_department_number_not_set_up_blocks_the_day():
    with db_session():
        sid = _store("rd-unmapped")
        _setup_departments(sid, skip=("3", "38"))
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        assert not figures.ready and figures.problem == PROBLEM_DEPARTMENTS
        assert figures.values == {}
        assert [(i.code, i.name, i.amount_cents) for i in figures.unmapped] == [
            ("3", "Lottery Paid In", 30_000),
        ]


def test_taxed_non_merchandise_is_refused_not_guessed():
    """Everything typed as lottery, nothing left untaxed to take it
    from: the split would go negative, so the day is not filled."""
    with db_session():
        sid = _store("rd-split")
        _setup_departments(sid)
        for dept in db.session.query(Department).filter_by(store_id=sid):
            dept.department_type = "lottery_sell"
        db.session.commit()
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        assert not figures.ready and figures.problem == PROBLEM_TAX_SPLIT


def test_the_period_is_the_registers_own_clock():
    with db_session():
        sid = _store("rd-period")
        _setup_departments(sid)
        _seed_reports(sid)
        figures = register_day(db.session, sid, DAY)
        assert figures.period_start.isoformat() == "2026-09-14T23:59:45"
        assert figures.period_end.isoformat() == "2026-09-15T23:59:18"


def test_other_days_and_other_stores_stay_out():
    with db_session():
        sid = _store("rd-scope")
        other = _store("rd-scope-other")
        _setup_departments(sid)
        _seed_reports(sid)
        assert not register_day(db.session, sid, date(2026, 9, 15)).has_data
        assert not register_day(db.session, other, DAY).has_data


# ── Onto the sheet ──────────────────────────────────────────


def test_pull_fills_empty_boxes_and_records_the_register_figure():
    with db_session():
        sid = _store("rd-pull")
        _setup_departments(sid)
        _seed_reports(sid)
        entry = get_or_create_entry(db.session, sid, DAY)
        assert is_pending(entry, register_day(db.session, sid, DAY))
        pull_register_day(db.session, entry)
        assert entry.lottery_sales_cents == 30_000
        assert entry.money_order_count == 2
        assert entry.fuel_gallons == 200.0
        assert originals_for(entry) == EXPECTED
        assert not is_pending(entry, register_day(db.session, sid, DAY))


def test_pull_never_replaces_a_number_somebody_typed():
    """Typed before the register's figure ever arrived, and typed
    after: both stay, with the register's figure on record."""
    with db_session():
        sid = _store("rd-typed")
        _setup_departments(sid)
        _seed_reports(sid)
        entry = get_or_create_entry(db.session, sid, DAY)
        update_entry(db.session, entry, {
            "lottery_sales": 31_000, "money_order": 41_000,
            "money_order_count": 5,
        })
        pull_register_day(db.session, entry)
        assert entry.lottery_sales_cents == 31_000
        assert originals_for(entry)["lottery_sales"] == 30_000
        # The count belongs to the money box the operator kept.
        assert entry.money_order_cents == 41_000
        assert entry.money_order_count == 5
        # A box nobody touched took the register's number.
        assert entry.lotto_sales_cents == 8_000

        update_entry(db.session, entry, {"lotto_sales": 9_000})
        pull_register_day(db.session, entry)
        assert entry.lotto_sales_cents == 9_000


def test_a_report_sent_again_updates_untouched_boxes_only():
    with db_session():
        sid = _store("rd-resent")
        _setup_departments(sid)
        _seed_reports(sid)
        entry = get_or_create_entry(db.session, sid, DAY)
        pull_register_day(db.session, entry)
        update_entry(db.session, entry, {"cards": 56_000})

        # The register sends the day again with different card totals.
        for row in db.session.query(PosMiscSummaryMovement).filter_by(
            store_id=sid, summary_sub_code="MOP",
        ):
            if row.summary_code == "sales" and row.summary_sub_code_modifier == "3":
                row.summary_amount_cents = 32_000
        for row in db.session.query(PosTaxLevelMovement).filter_by(
            store_id=sid, tax_level_id="101",
        ):
            row.tax_collected_amount_cents = 4_200
        db.session.commit()

        assert is_pending(entry, register_day(db.session, sid, DAY))
        pull_register_day(db.session, entry)
        assert entry.sales_tax_cents == 4_200          # untouched: follows
        assert entry.cards_cents == 56_000             # typed: stays
        assert originals_for(entry)["cards"] == 57_000


def test_pull_refuses_a_locked_day():
    with db_session():
        sid = _store("rd-locked")
        _setup_departments(sid)
        _seed_reports(sid)
        entry = get_or_create_entry(db.session, sid, DAY)
        set_lock(db.session, entry, locked=True, user_id=None)
        with pytest.raises(DayLockedError):
            pull_register_day(db.session, entry)
        assert originals_for(entry) == {}


def test_pull_refuses_a_day_that_is_not_ready():
    with db_session():
        sid = _store("rd-notready")
        _setup_departments(sid, skip=("3",))
        _seed_reports(sid)
        entry = get_or_create_entry(db.session, sid, DAY)
        with pytest.raises(RegisterDayNotReady):
            pull_register_day(db.session, entry)
        assert entry.taxable_sales_cents == 0


# ── The switch ──────────────────────────────────────────────


def test_the_feed_is_off_until_a_store_is_switched_on():
    with db_session():
        sid = _store("rd-flag")
        assert register_day_enabled(db.session, sid) is False
        _flag_on(sid)
        assert register_day_enabled(db.session, sid) is True


# ── HTTP ────────────────────────────────────────────────────


def _h(token):
    return {"Authorization": f"Bearer {token}"}


def _ready_store(store_id):
    with db_session():
        _setup_departments(store_id)
        _seed_reports(store_id)


def test_a_store_without_the_feed_sees_no_register_block(client, test_store_id):
    _ready_store(test_store_id)
    tok = login_admin(client, test_store_id)
    body = client.get(f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok)).get_json()
    assert body["register_day"] is None
    assert body["originals"] == {}
    r = client.post(f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok))
    assert r.status_code == 404
    after = client.get(f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok)).get_json()
    assert after["values"]["lottery_sales"] == 0


def test_opening_a_day_reports_the_register_and_changes_nothing(
    client, test_store_id,
):
    _ready_store(test_store_id)
    with db_session():
        _flag_on(test_store_id)
    tok = login_admin(client, test_store_id)
    body = client.get(f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok)).get_json()
    reg = body["register_day"]
    assert reg["has_data"] and reg["ready"] and reg["pending"]
    assert reg["problem"] == ""
    assert reg["unplaced"] == [
        {"kind": "payment_type", "code": "8", "name": "", "amount_cents": 500},
    ]
    assert reg["period_start"] and reg["period_end"]
    # A GET never writes (CSRF: the cookie is SameSite=Lax).
    assert body["originals"] == {}
    assert body["values"]["lottery_sales"] == 0


def test_the_register_route_fills_the_day(client, test_store_id):
    _ready_store(test_store_id)
    with db_session():
        _flag_on(test_store_id)
    tok = login_admin(client, test_store_id)
    r = client.post(f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok))
    assert r.status_code == 200, r.text
    body = r.get_json()
    assert body["originals"] == EXPECTED
    assert body["values"]["money_order_fee"] == 300
    assert body["counts"]["fuel_gallons"] == 200.0
    assert body["register_day"]["pending"] is False
    assert body["totals"]["sales_cents"] == 222_000


def test_the_register_route_refuses_a_locked_day(client, test_store_id):
    _ready_store(test_store_id)
    with db_session():
        _flag_on(test_store_id)
    tok = login_admin(client, test_store_id)
    assert client.post(
        f"/api/v2/storebook/{DAY_ISO}/lock", json={"locked": True},
        headers=_h(tok),
    ).status_code == 200
    r = client.post(f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok))
    assert r.status_code == 409
    body = client.get(f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok)).get_json()
    assert body["originals"] == {}
    # Still reported, so the page can say why nothing was taken.
    assert body["register_day"]["pending"] is True


def test_the_register_route_refuses_departments_not_set_up(
    client, test_store_id,
):
    with db_session():
        _setup_departments(test_store_id, skip=("3",))
        _seed_reports(test_store_id)
        _flag_on(test_store_id)
    tok = login_admin(client, test_store_id)
    body = client.get(f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok)).get_json()
    assert body["register_day"]["problem"] == "departments"
    assert body["register_day"]["pending"] is False
    assert body["register_day"]["unmapped"] == [{
        "kind": "department", "code": "3", "name": "Lottery Paid In",
        "amount_cents": 30_000,
    }]
    r = client.post(f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok))
    assert r.status_code == 409


def test_the_register_route_needs_edit_rights(client, test_store_id):
    from api.Core.Permissions import clear_user_permissions, set_user_permissions
    from api.Modules.Tenancy.Models import User
    _ready_store(test_store_id)
    with db_session():
        _flag_on(test_store_id)
        u = User(store_id=test_store_id, username="rd-viewer@x.com",
                 email="rd-viewer@x.com", role="employee",
                 full_name="Viewer", is_active=True)
        u.set_password("viewerpw1!")
        db.session.add(u)
        db.session.commit()
        uid = u.id
        set_user_permissions(test_store_id, uid, {"day_close": {"read": True}})
    try:
        tok = client.post("/api/v2/auth/login", json={
            "username": "rd-viewer@x.com", "password": "viewerpw1!",
            "store_id": test_store_id,
        }).get_json()["access_token"]
        assert client.get(
            f"/api/v2/storebook/{DAY_ISO}", headers=_h(tok),
        ).status_code == 200
        assert client.post(
            f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok),
        ).status_code == 403
    finally:
        clear_user_permissions(test_store_id, uid)


def test_the_register_route_writes_an_audit_row(client, test_store_id):
    from api.Modules.Audit.Models import OperatorAuditLog
    _ready_store(test_store_id)
    with db_session():
        _flag_on(test_store_id)
    tok = login_admin(client, test_store_id)
    client.post(f"/api/v2/storebook/{DAY_ISO}/register", headers=_h(tok))
    with db_session():
        row = (
            db.session.query(OperatorAuditLog)
            .filter_by(store_id=test_store_id, target_type="store_daily_entry")
            .order_by(OperatorAuditLog.id.desc())
            .first()
        )
        assert row is not None
        assert "register's day close" in row.summary

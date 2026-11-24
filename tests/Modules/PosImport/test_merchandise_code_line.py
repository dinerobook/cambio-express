"""Department-keyed sale lines (``MerchandiseCodeLine``) and fuel
prepays (``FuelPrepayLine``) in Gilbarco PJR files.

Passport writes a ``MerchandiseCodeLine`` when the cashier keys an
amount straight to a department instead of scanning an item: open
department sales, lotto sales and lottery / lotto cashes (negative
amounts). The parser used to read only ItemLine and FuelLine, so
these lines vanished from the department rollup and the
transaction viewer while the transaction totals still counted
them. A ``FuelPrepayLine`` is a deposit on a pump whose fuel the
linked completion event books as a FuelLine; it stays out of every
department total.

Fixtures are SYNTHETIC, shaped like real Passport files (element
names and nesting checked against a live site's export) — no
production journal data in the repo.
"""
from datetime import date

from api.Modules.PosImport.Services import (
    LINE_STATUS_CANCEL, aggregate_events, parse_pjr, rebuild_transactions,
)
from api.Modules.PosImport.Services.ingest import (
    mapping_status, rebuild_item_day_sales,
)
from tests._app import db, db_session


def _doc(event_xml: str) -> str:
    return f"""<?xml version ="1.0" encoding="ISO-8859-1" standalone="no"?>
 <NAXML-POSJournal version="3.4" release="3.4.0">
  <TransmissionHeader><StoreLocationID>1</StoreLocationID></TransmissionHeader>
  <JournalReport>
   <JournalHeader><BeginTime>09:15:00</BeginTime></JournalHeader>
   {event_xml}
  </JournalReport>
 </NAXML-POSJournal>"""


def _dept_line(code: str, desc: str, amount: str, qty: str = "1",
               status: str = "normal") -> str:
    return f"""<TransactionLine status="{status}">
      <MerchandiseCodeLine>
       <MerchandiseCode>{code}</MerchandiseCode>
       <Description>{desc}</Description>
       <ActualSalesPrice>{amount.lstrip('-')}</ActualSalesPrice>
       <RegularSellPrice>{amount.lstrip('-')}</RegularSellPrice>
       <SalesQuantity>{qty}</SalesQuantity>
       <SalesAmount>{amount}</SalesAmount>
       <ItemTax><TaxLevelID>99</TaxLevelID></ItemTax>
       <SalesRestrictCode>0</SalesRestrictCode>
      </MerchandiseCodeLine>
     </TransactionLine>"""


def _cash(amount: str, change: bool = False) -> str:
    return f"""<TransactionLine status="normal">
      <TenderInfo>
       <Tender><TenderCode>cash</TenderCode>
        <TenderSubCode>generic</TenderSubCode></Tender>
       <TenderAmount>{amount}</TenderAmount>
       <ChangeFlag value="{'yes' if change else 'no'}"/>
      </TenderInfo>
     </TransactionLine>"""


def _event(tag: str, lines: str, gross: str, txn: str = "5001") -> str:
    return _doc(f"""<{tag}>
    <EventSequenceID>{txn}</EventSequenceID>
    <CashierID>3</CashierID>
    <RegisterID>1</RegisterID>
    <TillID>0412</TillID>
    <TransactionID>{txn}</TransactionID>
    <BusinessDate>2025-06-02</BusinessDate>
    <TransactionDetailGroup>
     {lines}
    </TransactionDetailGroup>
    <TransactionSummary>
     <TransactionTotalGrossAmount>{gross}</TransactionTotalGrossAmount>
     <TransactionTotalNetAmount>{gross}</TransactionTotalNetAmount>
     <TransactionTotalTaxNetAmount>0</TransactionTotalTaxNetAmount>
     <TransactionTotalGrandAmount direction="Collected">{gross}</TransactionTotalGrandAmount>
    </TransactionSummary>
   </{tag}>""")


# A lotto ticket keyed to department 7 next to a scanned item.
LOTTO_SALE = _event("SaleEvent", (
    _dept_line("7", "Lotto (Sell)", "10.00", qty="5")
    + """<TransactionLine status="normal">
      <ItemLine>
       <ItemCode><POSCode>049000000443</POSCode>
        <POSCodeFormat format="upcA"></POSCodeFormat></ItemCode>
       <Description>COLA 20OZ</Description>
       <EntryMethod method="scan"></EntryMethod>
       <ActualSalesPrice>2.50</ActualSalesPrice>
       <MerchandiseCode>4</MerchandiseCode>
       <SalesQuantity>1</SalesQuantity>
       <SalesAmount>2.50</SalesAmount>
       <ItemTax><TaxLevelID>101</TaxLevelID></ItemTax>
      </ItemLine>
     </TransactionLine>"""
    + _cash("12.50")
), gross="12.50", txn="5001")

# A winning scratch ticket paid out: a refund whose only sale line
# is a negative department amount.
LOTTERY_CASH = _event("RefundEvent", (
    _dept_line("11", "Lottery (Cashed)", "-50.00", qty="-1")
    + _cash("-50.00", change=True)
), gross="-50.00", txn="5002")

# The cashier keyed $20 to Non-Taxable, cancelled it, keyed $8.
CANCELLED_DEPT = _event("SaleEvent", (
    _dept_line("5", "Non-Taxable", "20.00", status="cancel")
    + _dept_line("5", "Non-Taxable", "8.00")
    + _cash("8.00")
), gross="8.00", txn="5003")

# Paying $30 inside for pump 4 before fuelling.
FUEL_PREPAY = _event("SaleEvent", """<TransactionLine status="normal">
      <FuelPrepayLine>
       <FuelPositionID>4</FuelPositionID>
       <SalesAmount>30.00</SalesAmount>
      </FuelPrepayLine>
     </TransactionLine>""" + _cash("30.00"), gross="30.00", txn="5004")

DAY = date(2025, 6, 2)


def _store(slug: str) -> int:
    from api.Modules.Tenancy.Models import Store
    s = Store(name=slug, slug=slug, email=f"{slug}@x.com", plan="basic")
    db.session.add(s)
    db.session.commit()
    return int(s.id)


# ── Parsing ─────────────────────────────────────────────────


def test_department_line_is_parsed_with_its_fields():
    ev = parse_pjr(LOTTO_SALE)
    dept = [i for i in ev.items if i.merchandise_code == "7"]
    assert len(dept) == 1, "a keyed department sale must not vanish"
    line = dept[0]
    assert line.description == "Lotto (Sell)"
    assert line.amount_cents == 1000
    assert line.quantity == 5
    assert line.actual_price_cents == 1000
    assert line.regular_price_cents == 1000
    assert line.tax_level_id == "99"
    assert line.pos_code == ""
    assert line.is_fuel is False
    # Line order follows the TransactionLines: department line first.
    assert [i.line_seq for i in ev.items] == [1, 2]


def test_sale_lines_now_add_up_to_the_gross():
    """The point of the fix: the lines the parser returns account for
    the whole sale, as TransactionTotalGrossAmount says they should."""
    for doc in (LOTTO_SALE, LOTTERY_CASH):
        ev = parse_pjr(doc)
        assert sum(i.amount_cents for i in ev.items) == ev.gross_cents


def test_lottery_cash_is_negative_and_nets_out_of_its_department():
    ev = parse_pjr(LOTTERY_CASH)
    assert ev.kind == "refund"
    assert [(i.merchandise_code, i.amount_cents) for i in ev.items] == [
        ("11", -5000),
    ]
    agg = aggregate_events([ev])[0]
    assert agg.departments == {"11": -5000}
    assert agg.cash_cents == -5000


def test_cancelled_department_line_is_kept_but_never_money():
    ev = parse_pjr(CANCELLED_DEPT)
    statuses = [(i.amount_cents, i.status) for i in ev.items]
    assert (2000, LINE_STATUS_CANCEL) in statuses, (
        "the cancelled line stays visible to the viewer"
    )
    agg = aggregate_events([ev])[0]
    assert agg.departments == {"5": 800}


def test_fuel_prepay_is_not_a_department_sale():
    """A prepay has no department and its fuel is booked later by the
    linked completion's FuelLine — counting it here would put the
    same fuel into the day twice."""
    ev = parse_pjr(FUEL_PREPAY)
    assert ev.items == []
    agg = aggregate_events([ev])[0]
    assert agg.departments == {}
    assert agg.fuel == {}


def test_departments_roll_up_across_item_and_department_lines():
    events = [parse_pjr(d) for d in (LOTTO_SALE, LOTTERY_CASH, CANCELLED_DEPT)]
    agg = aggregate_events(events)[0]
    assert agg.departments == {"7": 1000, "4": 250, "11": -5000, "5": 800}


# ── Downstream ──────────────────────────────────────────────


def test_department_codes_go_through_the_mapping_gate():
    """A code that only ever arrives on a department line is a code
    the operator must map before the day can be booked."""
    with db_session():
        sid = _store("merch-line-gate")
        days = aggregate_events([parse_pjr(LOTTERY_CASH)])
        _mapped, unmapped = mapping_status(db.session, sid, days)
        assert unmapped == ["11"]


def test_item_movement_skips_department_lines():
    """Item movement is per scan code; a keyed department amount has
    none, so only the scanned cola moves."""
    from api.Modules.PosImport.Models import PosItemDaySale
    with db_session():
        sid = _store("merch-line-movement")
        events = [parse_pjr(LOTTO_SALE), parse_pjr(LOTTERY_CASH)]
        rebuild_item_day_sales(db.session, sid, DAY, events)
        db.session.commit()
        rows = db.session.query(PosItemDaySale).filter_by(store_id=sid).all()
        assert [(r.pos_code, r.amount_cents) for r in rows] == [
            ("049000000443", 250),
        ]


def test_department_lines_are_stored_on_the_transaction():
    from api.Modules.PosImport.Models import (
        PosTransaction, PosTransactionLine,
    )
    with db_session():
        sid = _store("merch-line-persist")
        ev = parse_pjr(LOTTO_SALE)
        ev.source_file = "PJR3402506020915001000001.xml"
        assert rebuild_transactions(db.session, sid, DAY, [ev]) == 1
        db.session.commit()
        txn = db.session.query(PosTransaction).filter_by(store_id=sid).one()
        lines = (
            db.session.query(PosTransactionLine)
            .filter_by(transaction_id=txn.id)
            .order_by(PosTransactionLine.line_seq)
            .all()
        )
        assert [(ln.merchandise_code, ln.pos_code, ln.amount_cents)
                for ln in lines] == [("7", "", 1000), ("4", "049000000443", 250)]
        assert lines[0].description == "Lotto (Sell)"
        assert lines[0].is_fuel is False


# ── Booking the day ─────────────────────────────────────────

# The $8.00 the cashier kept on Non-Taxable, handed back later.
NON_TAXABLE_REFUND = _event("RefundEvent", (
    _dept_line("5", "Non-Taxable", "-8.00", qty="-1")
    + _cash("-8.00", change=True)
), gross="-8.00", txn="5005")


def test_a_paid_out_department_is_booked_as_a_minus_line():
    """Lottery cashed is minus every day. The booked close's gross
    sales already has it taken off, so the department lines must
    carry it too: dropping it left them adding up to more than the
    close by exactly what was paid out. A department that nets to
    exactly zero is still no line."""
    from api.Modules.DayClose.Models import Department, RegisterClose
    from api.Modules.DayClose.Services import day_summary
    from api.Modules.PosImport.Models import PosMerchandiseMap
    from api.Modules.PosImport.Services.ingest import commit_business_day

    def events():
        out = []
        for n, doc in enumerate((
            LOTTO_SALE, LOTTERY_CASH, CANCELLED_DEPT, NON_TAXABLE_REFUND,
        )):
            ev = parse_pjr(doc)
            ev.source_file = f"PJR340250602091500100000{n}.xml"
            out.append(ev)
        return out

    with db_session():
        sid = _store("merch-line-paid-out")
        for code, name in (
            ("7", "Lotto (Sell)"), ("4", "Soda"),
            ("11", "Lottery (Cashed)"), ("5", "Non-Taxable"),
        ):
            dept = Department(store_id=sid, name=name)
            db.session.add(dept)
            db.session.flush()
            db.session.add(PosMerchandiseMap(
                store_id=sid, merchandise_code=code, department_id=dept.id,
            ))
        db.session.commit()

        def booked():
            close = db.session.query(RegisterClose).filter_by(store_id=sid).one()
            lines = {
                line.department.name: int(line.amount_cents)
                for line in close.department_sales
            }
            return int(close.gross_sales_cents), lines

        commit_business_day(db.session, sid, DAY, events=events(), created_by=None)
        db.session.commit()
        gross, lines = booked()
        assert lines == {
            "Lotto (Sell)": 1000, "Soda": 250, "Lottery (Cashed)": -5000,
        }, "Non-Taxable sold 8.00 and gave 8.00 back: no line"
        assert sum(lines.values()) == gross == -3750

        summary = day_summary(db.session, sid, DAY)
        assert {
            t.department.name: t.amount_cents for t in summary.department_totals
        } == lines

        # Booking the day again gives the same rows, not a second set.
        commit_business_day(db.session, sid, DAY, events=events(), created_by=None)
        db.session.commit()
        assert booked() == (gross, lines)

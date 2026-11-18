"""Two ways the Gilbarco import counted money twice in a day.

1. **Tax.** Passport's ``TransactionTotalNetAmount`` already includes
   tax (it equals ``TransactionTotalGrandAmount``), and the import
   booked it as gross_sales AND booked the tax on top. The pre-tax
   sale is Net − Tax, which is also the sum of the sale lines after
   promotions; ``TransactionTotalGrossAmount`` is before promotions.

2. **Prepaid fuel.** Passport writes the deposit when the customer
   pays, then a completion (``LinkedTransactionInfo``, reason
   fuelPrepay) restating the whole ticket once the pump stops. Both
   were summed. When a sale / refund completion exists the deposit
   leaves every money total and stays visible, marked superseded.

Fixtures are SYNTHETIC, shaped like real Passport 22.01 files — no
store data in the repo.
"""
import io
import zipfile
from datetime import date

import pytest

from api.Modules.PosImport.Services import (
    aggregate_events, commit_business_day, load_pjr_payload, parse_pjr,
    stage_journal_file, staged_events_for_day, with_staged_events,
)
from api.Modules.PosImport.Services.agent import rebook_for_late_completion
from api.Modules.PosImport.Services.naxml import (
    LINK_REASON_FUEL_PREPAY, supersede_prepaid_deposits,
)
from tests._app import db, db_session
from tests.Modules.PosImport.test_agent import _issue_key, _agent_upload
from tests.Modules.PosImport.test_ingest import _map_codes, _mk_department
from tests.Modules.PosImport.test_naxml import _sale
from tests.conftest import login_admin

D = "2025-03-04"
D2 = "2025-03-05"
DAY = date(2025, 3, 4)
DAY2 = date(2025, 3, 5)


# ── Synthetic Passport files ────────────────────────────────


def _doc(event_xml: str, begin_time: str) -> str:
    return f"""<?xml version ="1.0" encoding="ISO-8859-1" standalone="no"?>
 <NAXML-POSJournal version="3.4" release="3.4.0">
  <TransmissionHeader><StoreLocationID>1</StoreLocationID></TransmissionHeader>
  <JournalReport>
   <JournalHeader><BeginTime>{begin_time}</BeginTime></JournalHeader>
   {event_xml}
  </JournalReport>
 </NAXML-POSJournal>"""


def _event(tag, *, txn, start, business_date, lines, gross, net, tax,
           register="1", link=None):
    day, clock = start.split(" ")
    link_xml = ""
    if link is not None:
        l_register, l_txn, l_start = link
        l_day, l_clock = l_start.split(" ")
        link_xml = f"""<LinkedTransactionInfo>
      <OriginalStoreLocationID>1</OriginalStoreLocationID>
      <OriginalRegisterID>{l_register}</OriginalRegisterID>
      <OriginalTransactionID>{l_txn}</OriginalTransactionID>
      <OriginalEventStartDate>{l_day}</OriginalEventStartDate>
      <OriginalEventStartTime>{l_clock}</OriginalEventStartTime>
      <TransactionLinkReason>fuelPrepay</TransactionLinkReason>
     </LinkedTransactionInfo>"""
    return _doc(f"""<{tag}>
    <EventSequenceID>1</EventSequenceID>
    <TrainingModeFlag value="no"/>
    <CashierID>91</CashierID>
    <RegisterID>{register}</RegisterID>
    <TillID>1310</TillID>
    <OutsideSalesFlag value="no"/>
    <TransactionID>{txn}</TransactionID>
    <EventStartDate>{day}</EventStartDate>
    <EventStartTime>{clock}</EventStartTime>
    <BusinessDate>{business_date}</BusinessDate>
    {link_xml}
    <TransactionDetailGroup>{lines}</TransactionDetailGroup>
    <TransactionSummary>
     <TransactionTotalGrossAmount>{gross}</TransactionTotalGrossAmount>
     <TransactionTotalNetAmount>{net}</TransactionTotalNetAmount>
     <TransactionTotalTaxNetAmount>{tax}</TransactionTotalTaxNetAmount>
     <TransactionTotalGrandAmount direction="Collected">{net}</TransactionTotalGrandAmount>
    </TransactionSummary>
   </{tag}>""", begin_time=clock)


def _item(amount, *, status="normal", code="049000000443", merch="10"):
    return f"""<TransactionLine status="{status}"><ItemLine>
     <ItemCode><POSCode>{code}</POSCode>
      <POSCodeFormat format="upcA"></POSCodeFormat></ItemCode>
     <Description>COLA 20OZ</Description>
     <EntryMethod method="scan"></EntryMethod>
     <ActualSalesPrice>{amount}</ActualSalesPrice>
     <MerchandiseCode>{merch}</MerchandiseCode>
     <SalesQuantity>1</SalesQuantity>
     <SalesAmount>{amount}</SalesAmount>
    </ItemLine></TransactionLine>"""


def _prepay(amount, *, status="normal"):
    return f"""<TransactionLine status="{status}"><FuelPrepayLine>
     <FuelPositionID>8</FuelPositionID><SalesAmount>{amount}</SalesAmount>
    </FuelPrepayLine></TransactionLine>"""


def _fuel(amount, gallons, *, promotion=""):
    promo = (
        f"""<Promotion><PromotionID>1</PromotionID>
         <PromotionReason>combinationOffer</PromotionReason>
         <PromotionAmount>{promotion}</PromotionAmount></Promotion>"""
        if promotion else ""
    )
    return f"""<TransactionLine status="normal"><FuelLine>
     <FuelGradeID>001</FuelGradeID><FuelPositionID>8</FuelPositionID>
     <Description>UNLEAD REG</Description>
     <ActualSalesPrice>2.799</ActualSalesPrice>
     <MerchandiseCode>1024</MerchandiseCode>
     <SalesQuantity>{gallons}</SalesQuantity>
     <SalesAmount>{amount}</SalesAmount>{promo}
    </FuelLine></TransactionLine>"""


def _lotto_cash(amount):
    return f"""<TransactionLine status="normal"><MerchandiseCodeLine>
     <MerchandiseCode>40</MerchandiseCode><Description>LOTTO CASH</Description>
     <SalesQuantity>1</SalesQuantity><SalesAmount>{amount}</SalesAmount>
    </MerchandiseCodeLine></TransactionLine>"""


def _tax(taxable, collected):
    return f"""<TransactionLine status="normal"><TransactionTax>
     <TaxLevelID>101</TaxLevelID>
     <TaxableSalesAmount>{taxable}</TaxableSalesAmount>
     <TaxCollectedAmount>{collected}</TaxCollectedAmount>
    </TransactionTax></TransactionLine>"""


def _tender(amount, *, code="cash", change=False):
    flag = "yes" if change else "no"
    return f"""<TransactionLine status="normal"><TenderInfo>
     <Tender><TenderCode>{code}</TenderCode>
      <TenderSubCode>generic</TenderSubCode></Tender>
     <TenderAmount>{amount}</TenderAmount><ChangeFlag value="{flag}"/>
    </TenderInfo></TransactionLine>"""


DEPOSIT_START = f"{D} 12:48:02"


def _deposit(*, start=DEPOSIT_START, business_date=D, txn="1475"):
    """$40 prepaid on pump 8 plus a $2.00 cola ($0.16 tax): $42.16
    cash. Gross 42.00, Net = Grand = 42.16."""
    return _event(
        "SaleEvent", txn=txn, start=start, business_date=business_date,
        lines=_prepay("40") + _item("2.00") + _tax("2.00", "0.16")
        + _tender("42.16"),
        gross="42.00", net="42.16", tax="0.16",
    )


def _completion(*, tag="SaleEvent", start=f"{D} 13:02:10",
                business_date=D, link_start=DEPOSIT_START, txn="1481"):
    """The pump stopped at $30: the whole ticket again, the prepay
    line cancelled, a $30 FuelLine, the same $42.16 tendered and
    $10.00 handed back."""
    return _event(
        tag, txn=txn, start=start, business_date=business_date,
        link=("1", "1475", link_start),
        lines=_prepay("40", status="cancel") + _item("2.00")
        + _fuel("30", "10.718") + _tax("2.00", "0.16")
        + _tender("42.16") + _tender("-10.00", change=True),
        gross="32.00", net="32.16", tax="0.16",
    )


# A pump sale with a $2.06 promotion and a taxed $10 item, paid by
# card: Gross 60.73 is before the promotion, the lines (58.67) after.
PROMO_SALE = _event(
    "SaleEvent", txn="3001", start=f"{D} 09:15:00", business_date=D,
    lines=_item("10.00") + _fuel("48.67", "17.388", promotion="-2.06")
    + _tax("10.00", "0.83") + _tender("59.50", code="creditCards"),
    gross="60.73", net="59.50", tax="0.83",
)


def _parse(doc, name):
    ev = parse_pjr(doc)
    ev.source_file = name
    return ev


def _store(slug):
    from api.Modules.Tenancy.Models import Store
    s = Store(name=slug, slug=slug, email=f"{slug}@x.com", plan="basic")
    db.session.add(s)
    db.session.commit()
    return s.id


def _map_all(sid, *codes):
    from api.Modules.DayClose.Models import Department
    from api.Modules.PosImport.Services import set_mappings
    dept = Department(store_id=sid, name=f"Everything {sid}")
    db.session.add(dept)
    db.session.flush()
    set_mappings(db.session, sid, {c: int(dept.id) for c in codes})


def _stage(sid, name, doc):
    return stage_journal_file(
        db.session, sid, filename=name, content=doc.encode("ISO-8859-1"),
    )


def _close(sid, day):
    from api.Modules.DayClose.Models import RegisterClose
    return (
        db.session.query(RegisterClose)
        .filter_by(store_id=sid, report_date=day, source="gilbarco")
        .one()
    )


def _hourly(sid, day):
    from api.Modules.DayClose.Models import HourlySale
    return {
        int(r.hour): int(r.amount_cents)
        for r in db.session.query(HourlySale)
        .filter_by(store_id=sid, report_date=day, source="gilbarco")
        .all()
        if r.amount_cents
    }


# ── 1. Tax ──────────────────────────────────────────────────


def test_net_amount_carries_tax_so_sales_take_it_off():
    """Net − Tax is the pre-tax sale after promotions: equal to the
    lines, so departments add up to gross_sales and tenders to
    gross_sales + tax."""
    ev = parse_pjr(PROMO_SALE)
    assert ev.net_cents == ev.grand_total_cents == 5950
    assert ev.sales_cents == 5867
    assert sum(i.amount_cents for i in ev.items) == ev.sales_cents
    # Gross is before the promotion — the wrong pre-tax figure.
    assert ev.gross_cents == 6073

    agg = aggregate_events([ev])[0]
    assert agg.net_sales_cents == 5867
    assert agg.tax_cents == 83
    assert sum(agg.departments.values()) == agg.net_sales_cents
    assert agg.card_cents == agg.net_sales_cents + agg.tax_cents


def test_commit_books_pre_tax_gross_sales_and_balances_tenders():
    with db_session():
        sid = _store("tax-once")
        _map_all(sid, "10", "1024")
        commit_business_day(
            db.session, sid, DAY,
            events=[_parse(PROMO_SALE, "PJR-promo.xml")], created_by=None,
        )
        db.session.commit()
        close = _close(sid, DAY)
        assert close.gross_sales_cents == 5867
        assert close.sales_tax_cents == 83
        # Tenders − (gross + tax): the tax used to land here twice.
        assert close.tender_variance_cents == 0
        # The hourly chart is on the same pre-tax basis.
        assert _hourly(sid, DAY) == {9: 5867}


def test_refund_magnitude_is_pre_tax_too():
    ev = parse_pjr(_sale(amount="-5.00", tax_collected="-0.41",
                         tendered="-5.41", change="0"))
    ev.kind = "refund"
    agg = aggregate_events([ev])[0]
    assert agg.net_sales_cents == -500
    assert agg.refunds_cents == 500
    assert agg.tax_cents == -41


# ── 2. Prepaid fuel: parsing ────────────────────────────────


def test_parse_reads_the_prepay_link():
    deposit = parse_pjr(_deposit())
    completion = parse_pjr(_completion())
    assert deposit.has_fuel_prepay is True
    assert deposit.link_reason == ""
    assert deposit.is_prepay_deposit is True

    assert completion.link_reason == LINK_REASON_FUEL_PREPAY
    assert completion.linked_register_id == "1"
    assert completion.linked_transaction_id == "1475"
    assert completion.linked_started_at.isoformat() == "2025-03-04T12:48:02"
    # Its own prepay line is the cancelled one.
    assert completion.has_fuel_prepay is False
    assert completion.completes_prepay is True
    # The two halves share one key; a plain sale has none.
    assert completion.prepay_key == deposit.prepay_key == (
        "1|1475|2025-03-04T12:48:02"
    )
    assert parse_pjr(PROMO_SALE).prepay_key == ""


# ── 2. Prepaid fuel: one day ────────────────────────────────


def test_completion_supersedes_its_deposit_in_the_day_totals():
    deposit = _parse(_deposit(), "PJR-dep.xml")
    completion = _parse(_completion(), "PJR-comp.xml")
    [agg] = aggregate_events([deposit, completion])

    assert deposit.superseded is True
    assert deposit.superseded_by_file == "PJR-comp.xml"
    assert completion.superseded is False
    # The ticket once, as pumped: $2 cola + $30 fuel, $0.16 tax,
    # $32.16 net cash.
    assert agg.sale_count == 1
    assert agg.net_sales_cents == 3200
    assert agg.tax_cents == 16
    assert agg.cash_cents == 3216
    assert agg.departments == {"10": 200, "1024": 3000}
    assert agg.fuel["001"].amount_cents == 3000


def test_commit_counts_a_prepaid_ticket_once_everywhere():
    """Closes, hourly buckets, item movement — and both tickets kept
    in the transaction store, the deposit marked."""
    from api.Modules.PosImport.Models import PosItemDaySale, PosTransaction
    with db_session():
        sid = _store("prepay-once")
        _map_all(sid, "10", "1024")
        _stage(sid, "PJR-dep.xml", _deposit())
        _stage(sid, "PJR-comp.xml", _completion())
        commit_business_day(
            db.session, sid, DAY,
            events=staged_events_for_day(db.session, sid, DAY),
            created_by=None,
        )
        db.session.commit()

        close = _close(sid, DAY)
        assert close.gross_sales_cents == 3200
        assert close.sales_tax_cents == 16
        assert close.cash_total_cents == 3216
        assert close.tender_variance_cents == 0
        assert _hourly(sid, DAY) == {13: 3200}
        [cola] = db.session.query(PosItemDaySale).filter_by(store_id=sid).all()
        assert (cola.quantity, cola.amount_cents) == (1.0, 200)

        rows = {
            t.source_file: t
            for t in db.session.query(PosTransaction).filter_by(store_id=sid)
        }
        assert set(rows) == {"PJR-dep.xml", "PJR-comp.xml"}
        assert rows["PJR-dep.xml"].superseded is True
        assert rows["PJR-dep.xml"].superseded_by_file == "PJR-comp.xml"
        comp = rows["PJR-comp.xml"]
        assert comp.superseded is False
        assert comp.linked_reason == "fuelPrepay"
        assert comp.linked_register_id == "1"
        assert comp.linked_transaction_no == "1475"
        assert comp.linked_started_at.isoformat() == "2025-03-04T12:48:02"


def test_refund_completion_supersedes_a_refund_deposit():
    """Lottery cash paid out on a ticket that also took a prepay: a
    RefundEvent pair, treated exactly like a sale pair."""
    def ticket(txn, *, start, prepay_status, fuel, link=None):
        return _event(
            "RefundEvent", txn=txn, start=start, business_date=D, link=link,
            lines=_lotto_cash("-50.00") + _prepay("20", status=prepay_status)
            + fuel + _tender("-30.00", change=True),
            gross="-30.00", net="-30.00", tax="0",
        )
    deposit = _parse(ticket(
        "2001", start=f"{D} 15:00:00", prepay_status="normal", fuel="",
    ), "PJR-rdep.xml")
    completion = _parse(ticket(
        "2003", start=f"{D} 15:06:00", prepay_status="cancel",
        fuel=_fuel("20", "7.145"), link=("1", "2001", f"{D} 15:00:00"),
    ), "PJR-rcomp.xml")
    [agg] = aggregate_events([deposit, completion])
    assert deposit.superseded is True
    assert agg.refund_count == 1
    assert agg.net_sales_cents == -3000
    assert agg.cash_cents == -3000
    assert agg.departments == {"40": -5000, "1024": 2000}


def test_void_completion_keeps_the_deposit():
    """Passport sometimes writes the completion as a VoidEvent with
    normal lines. Voids never count, so letting it supersede the
    deposit would drop a real sale — the deposit keeps counting
    until the owner decides otherwise."""
    deposit = _parse(_deposit(), "PJR-dep.xml")
    void = _parse(_completion(tag="VoidEvent"), "PJR-void.xml")
    assert void.kind == "void" and void.completes_prepay is False
    [agg] = aggregate_events([deposit, void])
    assert deposit.superseded is False
    assert agg.sale_count == 1
    assert agg.net_sales_cents == 4200
    assert agg.cash_cents == 4216


def test_deposit_without_a_completion_still_counts():
    deposit = _parse(_deposit(), "PJR-dep.xml")
    [agg] = aggregate_events([deposit])
    assert deposit.superseded is False
    assert agg.net_sales_cents == 4200


def test_completion_whose_deposit_is_missing_counts_normally():
    """The deposit fell before the export started: the completion
    is the ticket."""
    [agg] = aggregate_events([_parse(_completion(), "PJR-comp.xml")])
    assert agg.net_sales_cents == 3200
    assert agg.cash_cents == 3216


def test_chained_completion_supersedes_the_completion_it_restates():
    """Passport can complete a prepay twice: the pump stops, then
    the change goes back on a second completion naming the first.
    The ticket still counts once, from the last one."""
    deposit = _parse(_deposit(), "PJR-dep.xml")
    first = _event(
        "SaleEvent", txn="1481", start=f"{D} 13:02:10", business_date=D,
        link=("1", "1475", DEPOSIT_START),
        lines=_prepay("40", status="cancel") + _item("2.00")
        + _fuel("30", "10.718") + _tax("2.00", "0.16") + _tender("42.16"),
        gross="32.00", net="32.16", tax="0.16",
    )
    second = _event(
        "SaleEvent", txn="1483", start=f"{D} 13:04:00", business_date=D,
        link=("1", "1481", f"{D} 13:02:10"),
        lines=_prepay("40", status="cancel") + _item("2.00")
        + _fuel("30", "10.718") + _tax("2.00", "0.16")
        + _tender("42.16") + _tender("-10.00", change=True),
        gross="32.00", net="32.16", tax="0.16",
    )
    events = [deposit, _parse(first, "PJR-1.xml"), _parse(second, "PJR-2.xml")]
    [agg] = aggregate_events(events)
    assert [e.superseded for e in events] == [True, True, False]
    assert events[1].superseded_by_file == "PJR-2.xml"
    assert agg.sale_count == 1
    assert agg.net_sales_cents == 3200
    assert agg.cash_cents == 3216


def test_reused_ticket_number_is_not_mistaken_for_the_deposit():
    """Passport reuses transaction numbers; only the full identity
    (register + number + start date and time) pairs two files."""
    other = _parse(_deposit(start=f"{D} 08:00:00"), "PJR-other.xml")
    completion = _parse(_completion(), "PJR-comp.xml")
    assert supersede_prepaid_deposits([other, completion]) == 0
    assert other.superseded is False


def test_supersede_is_idempotent():
    deposit = _parse(_deposit(), "PJR-dep.xml")
    completion = _parse(_completion(), "PJR-comp.xml")
    assert supersede_prepaid_deposits([deposit, completion]) == 1
    assert supersede_prepaid_deposits([deposit, completion]) == 0
    assert deposit.superseded is True


# ── 2. Prepaid fuel: across business days ──────────────────


def _cross_day_completion():
    # Rung at 22:45 on D, the site closed the day at 22:50, the pump
    # stopped at 22:58 — Passport books the completion to D + 1.
    return _completion(start=f"{D} 22:58:00", business_date=D2,
                       link_start=f"{D} 22:45:00")


def _cross_day_deposit():
    return _deposit(start=f"{D} 22:45:00")


def test_staging_keys_both_halves_of_a_prepaid_ticket():
    from api.Modules.PosImport.Models import PosJournalFile
    with db_session():
        sid = _store("prepay-key")
        _stage(sid, "PJR-dep.xml", _cross_day_deposit())
        _stage(sid, "PJR-comp.xml", _cross_day_completion())
        _stage(sid, "PJR-sale.xml", _sale(business_date=D))
        keys = {
            f.filename: f.prepay_key
            for f in db.session.query(PosJournalFile).filter_by(store_id=sid)
        }
        assert keys == {
            "PJR-dep.xml": "1|1475|2025-03-04T22:45:00",
            "PJR-comp.xml": "1|1475|2025-03-04T22:45:00",
            "PJR-sale.xml": "",
        }


def test_commit_finds_a_completion_staged_on_the_next_day():
    with db_session():
        sid = _store("prepay-next-day")
        _map_all(sid, "10", "17", "1024")
        _stage(sid, "PJR-dep.xml", _cross_day_deposit())
        _stage(sid, "PJR-sale.xml", _sale(business_date=D))
        _stage(sid, "PJR-comp.xml", _cross_day_completion())

        commit_business_day(
            db.session, sid, DAY,
            events=staged_events_for_day(db.session, sid, DAY),
            created_by=None,
        )
        commit_business_day(
            db.session, sid, DAY2,
            events=staged_events_for_day(db.session, sid, DAY2),
            created_by=None,
        )
        db.session.commit()
        # D keeps only the ice bag; the prepaid ticket lands on D + 1.
        assert _close(sid, DAY).gross_sales_cents == 299
        assert _close(sid, DAY2).gross_sales_cents == 3200


def test_upload_commit_sees_a_completion_staged_later():
    """The manual-upload path (upload ∪ staged) gets the same
    cross-day lookup."""
    with db_session():
        sid = _store("prepay-upload")
        _map_all(sid, "10", "17", "1024")
        _stage(sid, "PJR-comp.xml", _cross_day_completion())
        loaded = load_pjr_payload(_zip(_cross_day_deposit(), _sale(business_date=D)))
        commit_business_day(
            db.session, sid, DAY,
            events=with_staged_events(db.session, sid, DAY, loaded),
            created_by=None,
        )
        db.session.commit()
        assert _close(sid, DAY).gross_sales_cents == 299


def test_one_upload_holding_both_days_pairs_them():
    loaded = load_pjr_payload(_zip(
        _cross_day_deposit(), _sale(business_date=D), _cross_day_completion(),
    ))
    by_day = {a.business_date: a for a in aggregate_events(loaded.events)}
    assert by_day[DAY].net_sales_cents == 299
    assert by_day[DAY2].net_sales_cents == 3200


def _zip(*docs):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, doc in enumerate(docs):
            z.writestr(f"PJR{i:04}.xml", doc.encode("ISO-8859-1"))
    return buf.getvalue()


# ── 2. Prepaid fuel: the site agent ────────────────────────


def test_live_hourly_counts_a_prepaid_ticket_once_in_either_order():
    with db_session():
        sid = _store("prepay-live")
        _stage(sid, "PJR-dep.xml", _deposit())
        assert _hourly(sid, DAY) == {12: 4200}
        _stage(sid, "PJR-comp.xml", _completion())
        assert _hourly(sid, DAY) == {13: 3200}

        sid2 = _store("prepay-live-reversed")
        _stage(sid2, "PJR-comp.xml", _completion())
        _stage(sid2, "PJR-dep.xml", _deposit())
        assert _hourly(sid2, DAY) == {13: 3200}


def test_completion_after_the_day_was_booked_rebooks_it(client, test_store_id):
    """Auto-commit books D the moment D + 1's first file lands — here
    before the pump stopped. The completion then re-books D without
    the deposit; D + 1 counts the ticket when it is booked."""
    from api.Modules.Audit.Models import OperatorAuditLog
    from api.Modules.PosImport.Models import PosTransaction

    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    key = _issue_key(client, h)["key"]
    dept = _mk_department(client, h, "Everything")
    _map_codes(client, h, {"10": dept["id"], "17": dept["id"],
                           "1024": dept["id"]})

    assert _agent_upload(client, key, "P-001.xml", _cross_day_deposit()).status_code == 200
    _agent_upload(client, key, "P-002.xml", _sale(business_date=D))
    # First D + 1 file: D rolls and auto-books with the deposit.
    _agent_upload(client, key, "P-003.xml", _sale(business_date=D2))
    with db_session():
        assert _close(test_store_id, DAY).gross_sales_cents == 4200 + 299

    resp = _agent_upload(client, key, "P-004.xml", _cross_day_completion())
    assert resp.status_code == 200, resp.text
    with db_session():
        close = _close(test_store_id, DAY)
        assert close.gross_sales_cents == 299
        assert close.tender_variance_cents == 0
        deposit = (
            db.session.query(PosTransaction)
            .filter_by(store_id=test_store_id, source_file="P-001.xml").one()
        )
        assert deposit.superseded is True
        assert deposit.superseded_by_file == "P-004.xml"
        audit = (
            db.session.query(OperatorAuditLog)
            .filter_by(store_id=test_store_id, target_id=D,
                       action="commit_pos_import_auto")
            .order_by(OperatorAuditLog.id)
            .all()
        )
        assert len(audit) == 2
        assert "re-booked" in audit[-1].summary

    resp = client.post("/api/v2/posimport/staged/commit", headers=h,
                       json={"day": D2})
    assert resp.status_code == 200, resp.text
    with db_session():
        assert _close(test_store_id, DAY2).gross_sales_cents == 299 + 3200


def test_rebook_is_refused_when_the_day_holds_upload_only_tickets():
    """A day booked from a manual upload holds tickets that were
    never staged; re-booking from staged files would drop them."""
    with db_session():
        sid = _store("prepay-rebook-refused")
        _map_all(sid, "10", "17", "1024")
        _stage(sid, "PJR-dep.xml", _cross_day_deposit())
        loaded = load_pjr_payload(_zip(_sale(business_date=D)))  # never staged
        commit_business_day(
            db.session, sid, DAY,
            events=with_staged_events(db.session, sid, DAY, loaded),
            created_by=None,
        )
        result = _stage(sid, "PJR-comp.xml", _cross_day_completion())
        assert result.rebook_day == DAY
        assert rebook_for_late_completion(db.session, sid, DAY) is None
        db.session.commit()
        assert _close(sid, DAY).gross_sales_cents == 4200 + 299


def test_no_rebook_when_the_deposit_day_is_not_booked():
    with db_session():
        sid = _store("prepay-no-rebook")
        _stage(sid, "PJR-dep.xml", _cross_day_deposit())
        assert _stage(sid, "PJR-comp.xml", _cross_day_completion()).rebook_day is None


# ── 2. Prepaid fuel: the transaction viewer ────────────────


@pytest.fixture()
def booked_pair(test_store_id):
    with db_session():
        _map_all(test_store_id, "10", "1024")
        _stage(test_store_id, "PJR-dep.xml", _deposit())
        _stage(test_store_id, "PJR-comp.xml", _completion())
        commit_business_day(
            db.session, test_store_id, DAY,
            events=staged_events_for_day(db.session, test_store_id, DAY),
            created_by=None,
        )
        db.session.commit()
        from api.Modules.PosImport.Models import PosTransaction
        return {
            t.source_file: int(t.id)
            for t in db.session.query(PosTransaction)
            .filter_by(store_id=test_store_id)
        }


def test_viewer_lists_the_deposit_flagged_and_out_of_the_total(
    client, test_store_id, booked_pair,
):
    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    resp = client.get(
        f"/api/v2/posimport/transactions?start={D}&end={D}", headers=h,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    flags = {r["id"]: r["superseded"] for r in body["rows"]}
    assert flags == {
        booked_pair["PJR-dep.xml"]: True, booked_pair["PJR-comp.xml"]: False,
    }
    assert body["total"] == 2
    # $32.16 rung once — not $74.32.
    assert body["total_grand"] == pytest.approx(32.16)


def test_viewer_detail_links_the_two_halves(client, test_store_id, booked_pair):
    h = {"Authorization": f"Bearer {login_admin(client, test_store_id)}"}
    dep = client.get(
        f"/api/v2/posimport/transactions/{booked_pair['PJR-dep.xml']}",
        headers=h,
    ).json()["transaction"]
    assert dep["superseded"] is True
    assert dep["superseded_by_id"] == booked_pair["PJR-comp.xml"]
    assert dep["linked_id"] is None

    comp = client.get(
        f"/api/v2/posimport/transactions/{booked_pair['PJR-comp.xml']}",
        headers=h,
    ).json()["transaction"]
    assert comp["superseded"] is False
    assert comp["superseded_by_id"] is None
    assert comp["linked_reason"] == "fuelPrepay"
    assert comp["linked_transaction_no"] == "1475"
    assert comp["linked_id"] == booked_pair["PJR-dep.xml"]

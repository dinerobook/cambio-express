"""Synthetic Gilbarco Passport movement reports (G-7).

Same element structure as a live Passport 23.01 export (FGM / ISM /
MCM / MSM / TLM / TPM, ``NAXML-MovementReport`` 3.4, no namespace),
with invented values. No store data is in the repo.
"""
from __future__ import annotations

_FAMILY_ELEMENT = {
    "FGM": ("FuelGradeMovement", "FGMDetail"),
    "ISM": ("ItemSalesMovement", "ISMDetail"),
    "MCM": ("MerchandiseCodeMovement", "MCMDetail"),
    "MSM": ("MiscellaneousSummaryMovement", "MSMDetail"),
    "TLM": ("TaxLevelMovement", "TLMDetail"),
    "TPM": ("TankProductMovement", ""),
}


def movement_doc(
    family: str, body: str = "", *, business_date: str = "2025-12-05",
    begin_date: str | None = None, begin_time: str = "23:59:45",
    end_date: str = "2025-12-06", end_time: str = "23:59:18",
    primary_period: str = "2", secondary_period: str = "0",
    header: str | None = None,
) -> str:
    element, _ = _FAMILY_ELEMENT[family]
    if header is None:
        header = f"""<MovementHeader>
<ReportSequenceNumber>1</ReportSequenceNumber>
<PrimaryReportPeriod>{primary_period}</PrimaryReportPeriod>
<SecondaryReportPeriod>{secondary_period}</SecondaryReportPeriod>
<BusinessDate>{business_date}</BusinessDate>
<BeginDate>{begin_date or business_date}</BeginDate>
<BeginTime>{begin_time}</BeginTime>
<EndDate>{end_date}</EndDate>
<EndTime>{end_time}</EndTime>
</MovementHeader>"""
    return f"""<?xml version="1.0" encoding="ISO-8859-1"?>
<NAXML-MovementReport version="3.4">
<TransmissionHeader>
<StoreLocationID>1</StoreLocationID>
<VendorName>Gilbarco-VeederRoot</VendorName>
<VendorModelVersion>23.01.23.02</VendorModelVersion>
</TransmissionHeader>
<{element}>
{header}
{body}
</{element}>
</NAXML-MovementReport>"""


# ── FGM ────────────────────────────────────────────────────


def fgm_tier(code: str, volume: str, amount: str, discount: str = "0") -> str:
    return f"""<FGMPriceTierSummary>
<PriceTierCode>{code}</PriceTierCode>
<FGMSalesTotals>
<FuelGradeSalesVolume>{volume}</FuelGradeSalesVolume>
<FuelGradeSalesAmount>{amount}</FuelGradeSalesAmount>
<PumpTestTotals>
<PumpTestAmount>0</PumpTestAmount>
<PumpTestVolume>0</PumpTestVolume>
<ReturnTankID/>
</PumpTestTotals>
<TaxExemptSalesVolume>0</TaxExemptSalesVolume>
<DiscountAmount>{discount}</DiscountAmount>
<DiscountCount>{1 if discount != "0" else 0}</DiscountCount>
<DispenserDiscountAmount>0</DispenserDiscountAmount>
<DispenserDiscountCount>0</DispenserDiscountCount>
</FGMSalesTotals>
</FGMPriceTierSummary>"""


def fgm_detail(
    grade: str, position: str, meter_volume: str, meter_amount: str,
    tiers: list[str],
) -> str:
    return f"""<FGMDetail>
<FuelGradeID>{grade}</FuelGradeID>
<FGMPositionSummary>
<FuelPositionID>{position}</FuelPositionID>
<FGMNonResettableTotal>
<FuelGradeNonResettableTotalVolume>{meter_volume}</FuelGradeNonResettableTotalVolume>
<FuelGradeNonResettableTotalAmount>{meter_amount}</FuelGradeNonResettableTotalAmount>
</FGMNonResettableTotal>
{"".join(tiers)}
</FGMPositionSummary>
</FGMDetail>"""


def fgm(**kw: str) -> str:
    """Grade 001 on two pumps, two price tiers each; grade 002 on
    pump 1, one tier."""
    body = "".join([
        fgm_detail("001", "1", "41250.25", "98760.40", [
            fgm_tier("0001", "12.345", "40.12"),
            fgm_tier("0002", "20.5", "61.75", discount="1.25"),
        ]),
        fgm_detail("001", "2", "1000.10", "2500.20", [
            fgm_tier("0001", "5.25", "15.75"),
            fgm_tier("0002", "1.000", "2.50"),
        ]),
        fgm_detail("002", "1", "500.5", "1500.75", [
            fgm_tier("0001", "10.5", "35.12"),
        ]),
    ])
    return movement_doc("FGM", body, **kw)


# ── ISM ────────────────────────────────────────────────────


def ism_price(price: str, qty: str, amount: str, promo: str = "0") -> str:
    return f"""<ISMSellPriceSummary>
<ActualSalesPrice>{price}</ActualSalesPrice>
<ISMSalesTotals>
<SalesQuantity>{qty}</SalesQuantity>
<SalesAmount>{amount}</SalesAmount>
<DiscountAmount>0</DiscountAmount>
<DiscountCount>0</DiscountCount>
<PromotionAmount>{promo}</PromotionAmount>
<PromotionCount>{0 if promo == "0" else 1}</PromotionCount>
<RefundAmount>0</RefundAmount>
<RefundCount>0</RefundCount>
<TransactionCount>0</TransactionCount>
</ISMSalesTotals>
</ISMSellPriceSummary>"""


def ism_detail(
    code: str, description: str, merch: str, prices: list[str],
    fmt: str = "upcA", modifier: str = "0", units: str = "1",
) -> str:
    return f"""<ISMDetail>
<ItemCode>
<POSCodeFormat format="{fmt}"/>
<POSCode>{code}</POSCode>
<POSCodeModifier>{modifier}</POSCodeModifier>
</ItemCode>
<ItemID>{code}</ItemID>
<Description>{description}</Description>
<MerchandiseCode>{merch}</MerchandiseCode>
<SellingUnits>{units}</SellingUnits>
{"".join(prices)}
</ISMDetail>"""


def ism(**kw: str) -> str:
    body = "".join([
        ism_detail("012345678905", "COLA 20OZ", "10", [
            ism_price("2.49", "3", "7.47"),
            # Same item at a promo price: a second row, not a merge.
            ism_price(".99", "1", ".99", promo="-.99"),
        ]),
        ism_detail("4011", "BANANA", "8", [ism_price("0.35", "6", "2.10")],
                   fmt="plu", units="6"),
    ])
    return movement_doc("ISM", body, **kw)


# ── MCM ────────────────────────────────────────────────────


def mcm_detail(code: str, description: str, qty: str, amount: str,
               refund: str = "0", txns: str = "1") -> str:
    return f"""<MCMDetail>
<MerchandiseCode>{code}</MerchandiseCode>
<MerchandiseCodeDescription>{description}</MerchandiseCodeDescription>
<MCMSalesTotals>
<DiscountAmount>0</DiscountAmount>
<DiscountCount>0</DiscountCount>
<PromotionAmount>-.99</PromotionAmount>
<PromotionCount>1</PromotionCount>
<RefundAmount>{refund}</RefundAmount>
<RefundCount>{0 if refund == "0" else 1}</RefundCount>
<SalesQuantity>{qty}</SalesQuantity>
<SalesAmount>{amount}</SalesAmount>
<TransactionCount>{txns}</TransactionCount>
<OpenDepartmentSalesAmount>-1.50</OpenDepartmentSalesAmount>
<OpenDepartmentTransactionCount>2</OpenDepartmentTransactionCount>
</MCMSalesTotals>
</MCMDetail>"""


def mcm(**kw: str) -> str:
    body = mcm_detail("10", "SODA", "4", "8.46", txns="3") + mcm_detail(
        "1024", "LOTTERY", "2", "20", refund="-5.00",
    )
    return movement_doc("MCM", body, **kw)


# ── MSM ────────────────────────────────────────────────────


def msm_detail(code: str, sub: str, amount: str, count: str,
               modifier: str | None = None, tender: str = "",
               tender_sub: str = "") -> str:
    mod = (
        "" if modifier is None else
        f"<MiscellaneousSummarySubCodeModifier>{modifier}"
        "</MiscellaneousSummarySubCodeModifier>"
    )
    return f"""<MSMDetail>
<MiscellaneousSummaryCodes>
<MiscellaneousSummaryCode>{code}</MiscellaneousSummaryCode>
<MiscellaneousSummarySubCode>{sub}</MiscellaneousSummarySubCode>
{mod}
</MiscellaneousSummaryCodes>
<MSMSalesTotals>
<Tender>
<TenderCode>{tender}</TenderCode>
<TenderSubCode>{tender_sub}</TenderSubCode>
</Tender>
<MiscellaneousSummaryAmount>{amount}</MiscellaneousSummaryAmount>
<MiscellaneousSummaryCount>{count}</MiscellaneousSummaryCount>
</MSMSalesTotals>
</MSMDetail>"""


def msm(**kw: str) -> str:
    """payouts / total = payouts / vendorPay = the sum of the three
    vendorPay leaves; a naive sum of every payouts row is 3x."""
    body = "".join([
        msm_detail("safeDrop", "total", "800.00", "4", tender="cash",
                   tender_sub="generic"),
        msm_detail("payouts", "total", "-150.00", "3"),
        msm_detail("payouts", "vendorPay", "-150.00", "3"),
        msm_detail("payouts", "vendorPay", "-100.00", "0", modifier="3"),
        msm_detail("payouts", "vendorPay", "-30.00", "0", modifier="3"),
        msm_detail("payouts", "vendorPay", "-20.00", "0", modifier="3"),
        # A leaf repeated verbatim, with no subtotal (the real files
        # carry two identical totalizer rows like this).
        msm_detail("totalizer", "sales", "1000.00", "0", modifier="mdseOnly"),
        msm_detail("totalizer", "sales", "1000.00", "0", modifier="mdseOnly"),
        msm_detail("fuelSalesByGrade", "fuel", "40.12", "12.345",
                   modifier="1"),
    ])
    return movement_doc("MSM", body, **kw)


# ── TLM ────────────────────────────────────────────────────


def tlm_detail(level: str, taxable: str, tax: str, forgiven: str = "0") -> str:
    return f"""<TLMDetail>
<TaxLevelID>{level}</TaxLevelID>
<MerchandiseCode>0</MerchandiseCode>
<TaxableSalesAmount>{taxable}</TaxableSalesAmount>
<TaxableSalesRefundedAmount>0</TaxableSalesRefundedAmount>
<TaxCollectedAmount>{tax}</TaxCollectedAmount>
<TaxExemptSalesAmount>0</TaxExemptSalesAmount>
<TaxExemptSalesRefundedAmount>0</TaxExemptSalesRefundedAmount>
<TaxForgivenSalesAmount>{forgiven}</TaxForgivenSalesAmount>
<TaxForgivenSalesRefundedAmount>0</TaxForgivenSalesRefundedAmount>
<TaxRefundedAmount>0</TaxRefundedAmount>
</TLMDetail>"""


def tlm(**kw: str) -> str:
    body = tlm_detail("99", "1520.33", "125.43", forgiven="3.10") + tlm_detail(
        "101", "200.00", "16.50",
    )
    return movement_doc("TLM", body, **kw)


def tpm(**kw: str) -> str:
    return movement_doc("TPM", "", **kw)


ALL_FAMILIES = {
    "FGM": fgm, "ISM": ism, "MCM": mcm, "MSM": msm, "TLM": tlm, "TPM": tpm,
}

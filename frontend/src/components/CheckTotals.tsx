// A period's check cashing totals as KPI tiles: the Checks page's
// summary and the back office report show the same four.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Checks and reports").

import type { CheckTotals } from "../api/checkCashing";
import { KpiCard, KpiGrid } from "./ui";
import { useT } from "../i18n";
import { fmtMoney2, fmtNumber } from "../lib/formatters";

export function CheckTotalsGrid({ totals }: { totals: CheckTotals | undefined }) {
  const t = useT();
  return (
    <KpiGrid minWidth="9rem">
      <KpiCard
        label={t("checkCashing.sumCashed")}
        value={totals ? fmtNumber(totals.cashed) : "—"}
        sub={totals ? fmtMoney2(totals.amount) : undefined}
        tone="neon"
      />
      <KpiCard
        label={t("checkCashing.sumFees")}
        value={totals ? fmtMoney2(totals.fees) : "—"}
        sub={totals && totals.cashed > 0
          ? t("checkCashing.sumAverage", { amount: fmtMoney2(totals.average) })
          : undefined}
      />
      <KpiCard
        label={t("checkCashing.sumCash")}
        value={totals ? fmtMoney2(totals.cash) : "—"}
      />
      <KpiCard
        label={t("checkCashing.sumOther")}
        value={totals ? fmtNumber(totals.declined + totals.voided) : "—"}
        sub={totals ? t("checkCashing.statOther", {
          declined: totals.declined, voided: totals.voided,
        }) : undefined}
      />
    </KpiGrid>
  );
}

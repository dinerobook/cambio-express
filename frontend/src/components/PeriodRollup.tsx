import type {
  PurchasesBlock, SalesBlock, TransfersRollup,
} from "../api/dashboard";
import {
  Card, Section, Table, tdStyle, thStyle, tokens,
} from "./ui";
import { fmtMoney2 } from "../lib/formatters";
import { useT, type MessageKey } from "../i18n";

// The at-a-glance period table (D-5): the same four windows down
// the side, one column per thing the store measures.
//
// Columns appear only when their module is on, so an MSB-only
// store sees Transfers alone and a c-store without money services
// never sees an empty Transfers column. If nothing qualifies the
// whole section is absent rather than an empty table.
//
// The windows are the ones the blocks already compute — no second
// definition of "last 7 days" that could drift from the first.

const WINDOWS = [
  { key: "today", days: 0 },
  { key: "d7", days: 7 },
  { key: "d15", days: 15 },
  { key: "d30", days: 30 },
] as const;

type WindowKey = (typeof WINDOWS)[number]["key"];

export function PeriodRollup({
  sales, purchases, transfers,
}: {
  sales: SalesBlock | null;
  purchases: PurchasesBlock | null;
  transfers: TransfersRollup | null;
}) {
  const t = useT();
  const columns: Array<{
    label: MessageKey;
    values: Record<WindowKey, number>;
  }> = [];
  if (sales) {
    columns.push({
      label: "dash.sales",
      values: {
        today: sales.today, d7: sales.d7, d15: sales.d15, d30: sales.d30,
      },
    });
  }
  if (purchases) {
    columns.push({
      label: "dash.purchases",
      values: {
        today: purchases.today, d7: purchases.d7,
        d15: purchases.d15, d30: purchases.d30,
      },
    });
  }
  if (transfers) {
    columns.push({
      label: "batch.transfers",
      values: {
        today: transfers.today, d7: transfers.d7,
        d15: transfers.d15, d30: transfers.d30,
      },
    });
  }
  if (columns.length === 0) return null;

  return (
    <Section title={t("dash.byPeriod")}>
      <Card>
        <Table>
          <thead>
            <tr>
              <th style={thStyle}>{t("dash.days")}</th>
              {columns.map((c) => (
                <th key={c.label} style={thStyle}>{t(c.label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WINDOWS.map((w) => (
              <tr key={w.key}>
                <td style={tdStyle}>
                  {w.days === 0 ? t("dash.last24h") : t("dash.nDays", { n: w.days })}
                </td>
                {columns.map((c) => (
                  <td
                    key={c.label}
                    style={{ ...tdStyle, fontFamily: tokens.fontMono }}
                  >
                    {fmtMoney2(c.values[w.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </Section>
  );
}

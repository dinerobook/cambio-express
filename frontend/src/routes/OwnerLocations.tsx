import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import {
  useOwnerLocations,
  type OwnerPeriod,
  type OwnerStoreRow,
} from "../api/owner";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  Card, DataTable, Empty, Input, PageHeader, PageShell,
  TabsBar, TabsButton, type DataColumn,
} from "../components/ui";
import { csvMoney } from "../lib/csv";
import styles from "./OwnerLocations.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// Owner umbrella: per-store stats grid at /app/owner/locations.
// Period selector (today/month/year) drives the date window for
// transfers, volume, over/short. Free-text search filters by
// store name (case-insensitive).
//
// Subsequent PRs add /app/owner (dashboard with KPI cards),
// /app/owner/pl-rollup, and the connect/unlink flow.

const PERIODS: Array<{ slug: OwnerPeriod; label: string }> = [
  { slug: "today", label: "Today"      },
  { slug: "month", label: "This month" },
  { slug: "year",  label: "This year"  },
];

export default function OwnerLocations() {
  const identity = getCurrentIdentity();
  const [sp, setSP] = useSearchParams();
  const period = (sp.get("period") as OwnerPeriod) ?? "month";
  const q      = sp.get("q") ?? "";
  const [qDraft, setQDraft] = useState(q);

  const { data, isLoading, isError, error, refetch } = useOwnerLocations(period, q);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else       next.delete(key);
    setSP(next, { replace: true });
  }

  const isOwner =
    identity?.role === "owner" || identity?.role === "superadmin";
  if (!isOwner) {
    return (
      <PageShell>
        <PageHeader title="Locations" />
        <Empty>Sign in as an owner to view the multi-store umbrella.</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Locations"
        subtitle={data
          ? `${fmtNumber(data.matched)} of ${fmtNumber(data.total)} stores`
          : "—"}
      />

      <div className={styles.toolbar}>
        <TabsBar>
          {PERIODS.map((p) => (
            <TabsButton
              key={p.slug}
              active={period === p.slug}
              onClick={() => setParam("period", p.slug)}
            >
              {p.label}
            </TabsButton>
          ))}
        </TabsBar>
        <Input
          type="search"
          value={qDraft}
          placeholder="Search stores…"
          onChange={(e) => setQDraft(e.target.value)}
          onBlur={() => setParam("q", qDraft.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setParam("q", qDraft.trim());
            }
          }}
          style={{ maxWidth: "20rem" }}
        />
      </div>

      <Card>
        <DataTable
          columns={STORE_COLUMNS}
          rows={data && data.matched > 0 ? data.rows : data ? [] : undefined}
          rowKey={(r) => r.store_id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={
            data && data.total === 0
              ? "No stores connected yet"
              : `No stores match "${q}".`
          }
          emptyBody={
            data && data.total === 0
              ? "Ask each store admin to redeem an owner-connect code."
              : undefined
          }
          exportCsv={data && {
            filename: `locations-${period}`,
            allRows: data.rows,
          }}
        />
      </Card>
    </PageShell>
  );
}

/** Each store's figures for the period as the kit ``<DataTable>``. */
const STORE_COLUMNS: DataColumn<OwnerStoreRow>[] = [
  {
    key: "store", header: "Store",
    render: (r) => (
      <>
        <div className={styles.storeName}>{r.store_name}</div>
        <div className={styles.storeSlug}>{r.store_slug}</div>
      </>
    ),
    csv: (r) => r.store_name,
  },
  {
    key: "transfers", header: "Transfers", align: "right",
    render: (r) => <span className={styles.mono}>{fmtNumber(r.transfer_count)}</span>,
    csv: (r) => r.transfer_count,
  },
  {
    key: "volume", header: "Volume", align: "right",
    render: (r) => <span className={styles.mono}>{fmtMoney2(r.volume)}</span>,
    csv: (r) => csvMoney(r.volume),
  },
  {
    key: "overShort", header: "Over/Short", align: "right",
    render: (r) => (
      <span
        className={
          r.over_short < 0
            ? styles.overShortNeg
            : r.over_short > 0
              ? styles.overShortPos
              : styles.overShortZero
        }
      >
        {r.over_short >= 0 ? "+" : ""}{fmtMoney2(r.over_short)}
      </span>
    ),
    csv: (r) => csvMoney(r.over_short),
  },
  {
    key: "companies", header: "Companies",
    render: (r) => (
      <div className={styles.companyChips}>
        {r.companies.length === 0 ? (
          <span className={styles.dash}>—</span>
        ) : (
          r.companies.slice(0, 5).map((c) => (
            <span key={c.company} className={styles.chip}>
              {c.company} · {c.count}
            </span>
          ))
        )}
      </div>
    ),
    // Every company in the file, not only the first five chips.
    csv: (r) => r.companies.map((c) => `${c.company} ${c.count}`).join("; "),
  },
];

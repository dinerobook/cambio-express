import {
  useSuperadminSetupProgress,
  type SuperadminSetupProgressRow,
} from "../api/superadmin";
import { formatDate } from "../lib/datetime";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  ButtonLink, Card, DataTable, Input, PageHeader, PageShell, Pill,
  Select, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminSetupProgress.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtCount } from "../lib/formatters";

// Platform → Setup progress. For each store: companies added, charge
// per money order set, bank connected, first day locked — so a new
// store stuck in setup stands out. Opens on the stores not finished.
// A step that does not apply to a store (no Money services module, no
// company selling money orders) shows a dash and is not counted.

const STATUSES = [
  { value: "open", label: "Not finished" },
  { value: "done", label: "Finished" },
  { value: "all", label: "All stores" },
];

function Step({ done, children }: { done: boolean; children: string }) {
  return <Pill tone={done ? "success" : "warning"}>{children}</Pill>;
}

function NotUsed() {
  return <span className={styles.dash} title="Does not apply to this store">—</span>;
}

const COLUMNS: DataColumn<SuperadminSetupProgressRow>[] = [
  {
    key: "store", header: "Store",
    render: (r) => (
      <div className={styles.store}>
        <div className={styles.storeName}>{r.name}</div>
        <div className={styles.storeMeta}>
          {r.slug}{r.is_active ? "" : " · inactive"}
        </div>
      </div>
    ),
  },
  {
    key: "signed_up", header: "Signed up",
    render: (r) => (r.signed_up_on ? (
      <div>
        <div className={styles.mono}>{formatDate(r.signed_up_on)}</div>
        {r.days_since_signup !== null && (
          <div className={styles.storeMeta}>
            {r.days_since_signup === 0 ? "Today" : `${fmtCount(r.days_since_signup, "day")} ago`}
          </div>
        )}
      </div>
    ) : <NotUsed />),
  },
  {
    key: "companies", header: "Companies",
    render: (r) => (r.companies_added === null ? <NotUsed /> : (
      <Step done={r.companies_added}>
        {r.companies_added ? fmtCount(r.company_count, "company", "companies") : "Not added"}
      </Step>
    )),
  },
  {
    key: "charges", header: "Money order charge",
    render: (r) => (r.charges_set === null ? <NotUsed /> : (
      <Step done={r.charges_set}>
        {`${r.money_order_charges_set} of ${r.money_order_companies} set`}
      </Step>
    )),
  },
  {
    key: "bank", header: "Bank",
    render: (r) => (
      <Step done={r.bank_connected}>
        {r.bank_connected ? "Connected" : "Not connected"}
      </Step>
    ),
  },
  {
    key: "locked", header: "First day locked",
    render: (r) => (r.first_locked_day
      ? <span className={styles.mono}>{formatDate(r.first_locked_day)}</span>
      : <Step done={false}>Not yet</Step>),
  },
  {
    key: "progress", header: "Progress", align: "right",
    render: (r) => (
      <Pill tone={r.steps_done >= r.steps_total ? "accent" : "neutral"}>
        {`${r.steps_done} of ${r.steps_total}`}
      </Pill>
    ),
  },
  {
    key: "view", header: "", label: "", align: "right",
    render: (r) => (
      <ButtonLink to={`/superadmin/stores/${r.store_id}/drill`} tone="secondary" size="sm">
        View
      </ButtonLink>
    ),
  },
];

export default function SuperadminSetupProgress() {
  const filters = useUrlFilterState({ q: "", status: "open" }, { pageSizeKey: "setup-progress" });
  const q = filters.params.q.trim();
  const status = STATUSES.some((s) => s.value === filters.params.status)
    ? filters.params.status : "open";
  const { data, isLoading, isError, error, refetch } = useSuperadminSetupProgress({
    q, status, page: filters.page, perPage: filters.perPage,
  });

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Setup progress"
        subtitle={data ? fmtCount(data.total, "store") : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder="Search stores…"
              aria-label="Search stores"
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={status}
              aria-label="Setup"
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </div>
        )}
      />

      <Card>
        <DataTable
          columns={COLUMNS}
          rows={data?.rows}
          rowKey={(r) => r.store_id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={status === "open"
            ? "Every store has finished setup."
            : "No stores match the filters."}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>
    </PageShell>
  );
}

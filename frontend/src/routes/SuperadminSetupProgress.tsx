import {
  fetchSuperadminSetupProgress,
  useSuperadminSetupProgress,
  type SuperadminSetupProgressRow,
} from "../api/superadmin";
import { csvDate, formatDate } from "../lib/datetime";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  ButtonLink, Card, DataTable, Input, PageHeader, PageShell, Pill,
  Select, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminSetupProgress.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// Platform → Setup progress. For each store: companies added, charge
// per money order set, bank connected, first day locked — so a new
// store stuck in setup stands out. Opens on the stores not finished.
// A step that does not apply to a store (no Money services module, no
// company selling money orders) shows a dash and is not counted.

const STATUSES: { value: string; label: MessageKey }[] = [
  { value: "open", label: "saSetup.open" },
  { value: "done", label: "saSetup.done" },
  { value: "all", label: "saSetup.all" },
];

function Step({ done, children }: { done: boolean; children: string }) {
  return <Pill tone={done ? "success" : "warning"}>{children}</Pill>;
}

function NotUsed() {
  const t = useT();
  return <span className={styles.dash} title={t("saSetup.notApply")}>—</span>;
}

function chargesLabel(r: SuperadminSetupProgressRow): string {
  return translate("saSetup.chargesSet", {
    done: fmtNumber(r.money_order_charges_set), total: fmtNumber(r.money_order_companies),
  });
}

function progressLabel(r: SuperadminSetupProgressRow): string {
  return translate("saSetup.progress", {
    done: fmtNumber(r.steps_done), total: fmtNumber(r.steps_total),
  });
}

function setupColumns(): DataColumn<SuperadminSetupProgressRow>[] {
  const t = translate;
  const bankLabel = (r: SuperadminSetupProgressRow) =>
    (r.bank_connected ? t("saSetup.connected") : t("saSetup.notConnected"));
  return [
  {
    key: "store", header: t("saSetup.colStore"),
    render: (r) => (
      <div className={styles.store}>
        <div className={styles.storeName}>{r.name}</div>
        <div className={styles.storeMeta}>
          {r.slug}{r.is_active ? "" : t("saSetup.inactive")}
        </div>
      </div>
    ),
    csv: (r) => r.name,
  },
  {
    key: "signed_up", header: t("saSetup.colSignedUp"),
    render: (r) => (r.signed_up_on ? (
      <div>
        <div className={styles.mono}>{formatDate(r.signed_up_on)}</div>
        {r.days_since_signup !== null && (
          <div className={styles.storeMeta}>
            {r.days_since_signup === 0
              ? t("saSetup.today")
              : tn("saSetup.daysAgo", r.days_since_signup, fmtNumber)}
          </div>
        )}
      </div>
    ) : <NotUsed />),
    csv: (r) => csvDate(r.signed_up_on),
  },
  {
    key: "companies", header: t("saSetup.colCompanies"),
    render: (r) => (r.companies_added === null ? <NotUsed /> : (
      <Step done={r.companies_added}>
        {r.companies_added
          ? tn("saSetup.companies", r.company_count, fmtNumber)
          : t("saSetup.notAdded")}
      </Step>
    )),
    csv: (r) => (r.companies_added === null ? "" : r.company_count),
  },
  {
    key: "charges", header: t("saSetup.colCharge"),
    render: (r) => (r.charges_set === null ? <NotUsed /> : (
      <Step done={r.charges_set}>
        {chargesLabel(r)}
      </Step>
    )),
    csv: (r) => (r.charges_set === null ? "" : chargesLabel(r)),
  },
  {
    key: "bank", header: t("saSetup.colBank"),
    render: (r) => (
      <Step done={r.bank_connected}>
        {bankLabel(r)}
      </Step>
    ),
    csv: bankLabel,
  },
  {
    key: "locked", header: t("saSetup.colLocked"),
    render: (r) => (r.first_locked_day
      ? <span className={styles.mono}>{formatDate(r.first_locked_day)}</span>
      : <Step done={false}>{t("saSetup.notYet")}</Step>),
    csv: (r) => csvDate(r.first_locked_day),
  },
  {
    key: "progress", header: t("saSetup.colProgress"), align: "right",
    render: (r) => (
      <Pill tone={r.steps_done >= r.steps_total ? "accent" : "neutral"}>
        {progressLabel(r)}
      </Pill>
    ),
    csv: progressLabel,
  },
  {
    key: "view", header: "", label: "", align: "right",
    render: (r) => (
      <ButtonLink to={`/superadmin/stores/${r.store_id}/drill`} tone="secondary" size="sm">
        {t("common.view")}
      </ButtonLink>
    ),
  },
  ];
}

export default function SuperadminSetupProgress() {
  const t = useT();
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
        title={navWord("Setup progress")}
        subtitle={data ? tn("saSetup.stores", data.total, fmtNumber) : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder={t("saSetup.search")}
              aria-label={t("saSetup.searchLabel")}
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={status}
              aria-label={t("saSetup.filterLabel")}
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>{t(s.label)}</option>
              ))}
            </Select>
          </div>
        )}
      />

      <Card>
        <DataTable
          columns={setupColumns()}
          rows={data?.rows}
          rowKey={(r) => r.store_id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={status === "open"
            ? t("saSetup.allDone")
            : t("saSetup.noMatch")}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "setup-progress",
            fetchPage: (page, perPage) => fetchSuperadminSetupProgress({ q, status, page, perPage }),
            extraColumns: [
              { header: t("saSetup.colSlug"), csv: (r) => r.slug },
              { header: t("common.active"), csv: (r) => (r.is_active ? t("common.yes") : t("common.no")) },
            ],
          }}
        />
      </Card>
    </PageShell>
  );
}

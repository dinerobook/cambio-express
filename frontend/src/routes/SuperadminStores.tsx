import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  bulkStoreAction,
  fetchSuperadminStoresPage,
  useSuperadminStoresPage,
  type SuperadminStoreRow,
} from "../api/superadmin";
import { billingCycleLabel, planLabel, planTone } from "../api/billing";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { csvDate, formatDate } from "../lib/datetime";
import { useStoreSelection } from "../lib/useStoreSelection";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Alert, Button, ButtonLink, Checkbox,
  Card, DataTable, Empty, Input, PageHeader, PageShell, Pill,
  Select, useToast, type CsvColumn, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminStores.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { t as translate, tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Platform-wide stores list at /app/superadmin/stores — superadmin's
// "what's going on across all customers?" view. Search, sort and
// paging run on the server and live in the URL; the bulk bar acts on
// the stores ticked on this page.

export default function SuperadminStores() {
  const t = useT();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "" }, {
    pageSizeKey: "superadmin-stores",
    defaultSort: { key: "created", direction: "desc" },
  });
  const q = filters.params.q;
  const listQuery = {
    q: q.length >= 2 ? q : "",
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useSuperadminStoresPage({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [bulkAction, setBulkAction] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Selection is over the stores on screen: "Select all" means the
  // visible rows, and a bulk action never reaches a store the search
  // or another page has hidden.
  const visibleIds = (data?.rows ?? []).map((r) => r.store_id);
  const selection = useStoreSelection(visibleIds);
  const selected = selection.selected.filter((id) => visibleIds.includes(id));

  // Built during render so the headers follow a language switch.
  const columns = storeColumns({
    isSelected: selection.isSelected,
    allSelected: selection.allSelected,
    onToggle: selection.toggle,
    onToggleAll: selection.toggleAll,
  });

  async function runBulk() {
    if (selected.length === 0 || !bulkAction) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const action = bulkAction as "extend_trial" | "enable" | "disable";
      const res = await bulkStoreAction(selected, action);
      toast({ message: tn("saStores.updated", res.count, fmtNumber), tone: "success" });
      selection.clear();
      setBulkAction("");
      qc.invalidateQueries({ queryKey: ["superadmin", "stores"] });
    } catch (err) {
      setBulkError(apiErrorMessage(err, t("saStores.bulkFailed")));
    } finally {
      setBulkBusy(false);
    }
  }

  if (identity?.role !== "superadmin") {
    return (
      <PageShell>
        <PageHeader title={navWord("Stores")} />
        <Empty>{t("sa.scopeRequired")}</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Stores")}
        subtitle={data
          ? tn(q.length >= 2 ? "saStores.matches" : "saStores.stores", data.total, fmtNumber)
          : "—"}
        actions={(
          <Input
            type="search"
            value={filters.draft.q ?? q}
            placeholder={t("saStores.search")}
            aria-label={t("saStores.searchLabel")}
            onChange={(e) => filters.debounced("q", e.target.value)}
            style={{ maxWidth: "22rem" }}
          />
        )}
      />

      {selected.length > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>
            {tn("saStores.selected", selected.length, fmtNumber)}
          </span>
          <Select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
            <option value="">{t("saStores.chooseAction")}</option>
            <option value="extend_trial">{t("saStores.extendTrial")}</option>
            <option value="enable">{t("saStores.enable")}</option>
            <option value="disable">{t("saStores.disable")}</option>
          </Select>
          <Button
            onClick={() => { void runBulk(); }}
            busy={bulkBusy}
            disabled={!bulkAction || bulkBusy}
            size="sm"
          >
            {t("saStores.apply")}
          </Button>
          <Button tone="secondary" size="sm" onClick={selection.clear}>
            {t("saStores.clear")}
          </Button>
        </div>
      )}

      {bulkError && <Alert tone="error">{bulkError}</Alert>}

      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(r) => r.store_id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("saStores.empty")}
          sort={filters.sort}
          page={data && {
            page: data.page ?? 1, totalPages: data.total_pages ?? 1, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "stores",
            fetchPage: (page, perPage) => fetchSuperadminStoresPage({ ...listQuery, page, perPage }),
            extraColumns: storeCsvExtras(),
          }}
        />
      </Card>
    </PageShell>
  );
}

function storeColumns({ isSelected, allSelected, onToggle, onToggleAll }: {
  isSelected: (id: number) => boolean;
  allSelected: boolean;
  onToggle: (id: number) => void;
  onToggleAll: () => void;
}): DataColumn<SuperadminStoreRow>[] {
  const t = translate;
  return [
    {
      key: "select", label: "",
      header: (
        <Checkbox
          checked={allSelected} onChange={onToggleAll}
          aria-label={t("saStores.selectAll")}
        />
      ),
      render: (r) => (
        <Checkbox
          checked={isSelected(r.store_id)}
          onChange={() => onToggle(r.store_id)}
          aria-label={t("saStores.selectOne", { name: r.name })}
        />
      ),
    },
    {
      key: "store", header: t("saStores.colStore"), sortKey: "name",
      csv: (r) => r.name,
      render: (r) => (
        <div>
          <div className={styles.storeName}>{r.name}</div>
          <div className={styles.storeMeta}>
            {r.slug}
            {r.email ? ` · ${r.email}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "plan", header: t("saStores.colPlan"), sortKey: "plan",
      render: (r) => <PlanPill plan={r.plan} cycle={r.billing_cycle} />,
      csv: (r) => planLabel(r.plan),
    },
    {
      key: "status", header: t("common.status"), sortKey: "status", sortFirst: "desc",
      render: (r) => (
        <Pill tone={r.is_active ? "accent" : "neutral"}>
          {r.is_active ? t("common.active") : t("common.inactive")}
        </Pill>
      ),
      csv: (r) => (r.is_active ? t("common.active") : t("common.inactive")),
    },
    { key: "trial", header: t("saStores.colTrial"), render: (r) => <TrialCell row={r} />,
      csv: (r) => (r.data_retention_until
        ? t("saStores.purge", { date: csvDate(r.data_retention_until) })
        : r.plan === "trial" && r.trial_ends_at
          ? t("saStores.trialEnds", { date: csvDate(r.trial_ends_at) }) : "") },
    {
      key: "stripe", header: STRIPE,
      render: (r) => (r.stripe_customer_id ? (
        <span className={styles.stripeId}>
          {r.stripe_customer_id.slice(0, 14)}…
        </span>
      ) : (
        <span className={styles.dash}>—</span>
      )),
      csv: (r) => r.stripe_customer_id,
    },
    {
      key: "created", header: t("saStores.colCreated"), sortKey: "created", sortFirst: "desc",
      render: (r) => <span className={styles.monoMuted}>{formatDate(r.created_at)}</span>,
      csv: (r) => csvDate(r.created_at),
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

/** The file carries the store's address fields the Store cell packs
 *  under the name. */
function storeCsvExtras(): CsvColumn<SuperadminStoreRow>[] {
  const t = translate;
  return [
    { header: t("saSetup.colSlug"), csv: (r) => r.slug },
    { header: t("common.email"), csv: (r) => r.email },
    { header: t("saStores.colBillingCycle"), csv: (r) => billingCycleLabel(r.billing_cycle) },
  ];
}

// A product name: the same in every language.
const STRIPE = "Stripe";

function PlanPill({ plan, cycle }: { plan: string; cycle: string }) {
  return (
    <Pill tone={planTone(plan)}>
      {planLabel(plan)}{cycle ? ` · ${billingCycleLabel(cycle)}` : ""}
    </Pill>
  );
}

function TrialCell({ row }: { row: SuperadminStoreRow }) {
  const t = useT();
  if (row.data_retention_until) {
    return (
      <span className={styles.trialRetention}>
        {t("saStores.purge", { date: formatDate(row.data_retention_until) })}
      </span>
    );
  }
  if (row.plan === "trial" && row.trial_ends_at) {
    return (
      <span className={styles.trialEnds}>
        {t("saStores.trialEnds", { date: formatDate(row.trial_ends_at) })}
      </span>
    );
  }
  return <span className={styles.dash}>—</span>;
}

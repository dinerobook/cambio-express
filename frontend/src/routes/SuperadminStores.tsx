import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  bulkStoreAction,
  useSuperadminStoresPage,
  type SuperadminStoreRow,
} from "../api/superadmin";
import { planTone } from "../api/billing";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { useStoreSelection } from "../lib/useStoreSelection";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Alert, Breadcrumbs, Button, ButtonLink, Checkbox,
  Card, DataTable, Empty, Input, PageHeader, PageShell, Pill,
  Select, useToast, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminStores.module.css";

// Platform-wide stores list at /app/superadmin/stores — superadmin's
// "what's going on across all customers?" view. Search, sort and
// paging run on the server and live in the URL; the bulk bar acts on
// the stores ticked on this page.

export default function SuperadminStores() {
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "" }, {
    pageSizeKey: "superadmin-stores",
    defaultSort: { key: "created", direction: "desc" },
  });
  const q = filters.params.q;
  const { data, isLoading, isError, error, refetch } = useSuperadminStoresPage({
    q: q.length >= 2 ? q : "",
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
    page: filters.page,
    perPage: filters.perPage,
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

  const columns = useMemo(() => storeColumns({
    isSelected: selection.isSelected,
    allSelected: selection.allSelected,
    onToggle: selection.toggle,
    onToggleAll: selection.toggleAll,
  }), [selection.isSelected, selection.allSelected, selection.toggle, selection.toggleAll]);

  async function runBulk() {
    if (selected.length === 0 || !bulkAction) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const action = bulkAction as "extend_trial" | "enable" | "disable";
      const res = await bulkStoreAction(selected, action);
      toast({ message: `${res.count} store${res.count === 1 ? "" : "s"} updated.`, tone: "success" });
      selection.clear();
      setBulkAction("");
      qc.invalidateQueries({ queryKey: ["superadmin", "stores"] });
    } catch (err) {
      setBulkError(apiErrorMessage(err, "Bulk action failed."));
    } finally {
      setBulkBusy(false);
    }
  }

  if (identity?.role !== "superadmin") {
    return (
      <PageShell>
        <PageHeader title="All stores" />
        <Empty>Superadmin scope required.</Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>

      <Breadcrumbs crumbs={[{ label: "Platform" }, { label: "Stores" }]} />

      <PageHeader
        title="All stores"
        subtitle={data
          ? `${data.total.toLocaleString()} store${data.total === 1 ? "" : "s"}${q.length >= 2 ? " match" : ""}`
          : "—"}
        actions={(
          <Input
            type="search"
            value={filters.draft.q ?? q}
            placeholder="Search name, slug, email…"
            aria-label="Search stores"
            onChange={(e) => filters.debounced("q", e.target.value)}
            style={{ maxWidth: "22rem" }}
          />
        )}
      />

      {selected.length > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selected.length} selected</span>
          <Select value={bulkAction} onChange={(e) => setBulkAction(e.target.value)}>
            <option value="">— Choose action —</option>
            <option value="extend_trial">Extend trial (+14d)</option>
            <option value="enable">Enable</option>
            <option value="disable">Disable</option>
          </Select>
          <Button
            onClick={() => { void runBulk(); }}
            busy={bulkBusy}
            disabled={!bulkAction || bulkBusy}
            size="sm"
          >
            Apply
          </Button>
          <Button tone="secondary" size="sm" onClick={selection.clear}>
            Clear
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
          emptyTitle="No stores match these filters."
          sort={filters.sort}
          page={data && {
            page: data.page ?? 1, totalPages: data.total_pages ?? 1, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
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
  return [
    {
      key: "select", label: "",
      header: (
        <Checkbox
          checked={allSelected} onChange={onToggleAll}
          aria-label="Select all stores"
        />
      ),
      render: (r) => (
        <Checkbox
          checked={isSelected(r.store_id)}
          onChange={() => onToggle(r.store_id)}
          aria-label={`Select ${r.name}`}
        />
      ),
    },
    {
      key: "store", header: "Store", sortKey: "name",
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
      key: "plan", header: "Plan", sortKey: "plan",
      render: (r) => <PlanPill plan={r.plan} cycle={r.billing_cycle} />,
    },
    {
      key: "status", header: "Status", sortKey: "status", sortFirst: "desc",
      render: (r) => (
        <Pill tone={r.is_active ? "accent" : "neutral"}>
          {r.is_active ? "Active" : "Inactive"}
        </Pill>
      ),
    },
    { key: "trial", header: "Trial / retention", render: (r) => <TrialCell row={r} /> },
    {
      key: "stripe", header: "Stripe",
      render: (r) => (r.stripe_customer_id ? (
        <span className={styles.stripeId}>
          {r.stripe_customer_id.slice(0, 14)}…
        </span>
      ) : (
        <span className={styles.dash}>—</span>
      )),
    },
    {
      key: "created", header: "Created", sortKey: "created", sortFirst: "desc",
      render: (r) => <span className={styles.monoMuted}>{formatDate(r.created_at)}</span>,
    },
    {
      key: "view", header: "", label: "", align: "right",
      render: (r) => (
        <ButtonLink href={`/superadmin/stores/${r.store_id}/drill`} tone="secondary" size="sm">
          View
        </ButtonLink>
      ),
    },
  ];
}

function PlanPill({ plan, cycle }: { plan: string; cycle: string }) {
  const label = plan.charAt(0).toUpperCase() + plan.slice(1);
  return (
    <Pill tone={planTone(plan)}>
      {label}{cycle ? ` · ${cycle}` : ""}
    </Pill>
  );
}

function TrialCell({ row }: { row: SuperadminStoreRow }) {
  if (row.data_retention_until) {
    return (
      <span className={styles.trialRetention}>
        Purge {formatDate(row.data_retention_until)}
      </span>
    );
  }
  if (row.plan === "trial" && row.trial_ends_at) {
    return (
      <span className={styles.trialEnds}>
        Trial ends {formatDate(row.trial_ends_at)}
      </span>
    );
  }
  return <span className={styles.dash}>—</span>;
}

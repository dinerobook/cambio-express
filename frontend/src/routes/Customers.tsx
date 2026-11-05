import { useState } from "react";

import { useUrlFilterState } from "../lib/useUrlFilterState";

import {
  mergeCustomers,
  useCustomerSearch,
  type CustomerRow,
} from "../api/customers";
import { apiErrorMessage, downloadCsv } from "../lib/api";
import { hasPermission } from "../lib/permissions";
import { getCurrentIdentity } from "../lib/auth";
import { maskPhone } from "../lib/format";
import {
  Alert, Button, Card, Checkbox, Empty, EmptyState, ErrorState, Field,
  Input, Modal, PageHeader, PageShell, Section, space, Table, tdStyle, thStyle,
  Loading,
  useToast,
} from "../components/ui";
import styles from "./Customers.module.css";
import { todayIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { navWord } from "../i18n/navWords";
import { tNodes, tn, useT } from "../i18n";
import { fmtNumber } from "../lib/formatters";

// Customer search at /app/customers. Live-search box; results
// split into "exact matches" (phone/full-name match) and
// "suggestions" (fuzzy near-misses) — same shape the legacy
// /api/customers/search returns.
//
// Two interaction modes:
//   * search mode (default) — type to filter; rows are plain
//     read-only summaries.
//   * merge mode — admins / owners only. Pick exactly two rows;
//     pick a winner; confirm; the loser's transfers get re-pointed
//     and the loser row is deleted. Backed by POST
//     /api/v2/customers/{winner_id}/merge.
//
// Search query lives in the URL query string so refresh + back
// preserve state, just like the transfers list.
export default function Customers() {
  const t = useT();
  const identity = getCurrentIdentity();
  // 300ms debounce + 2-char minimum via the shared URL-filter hook
  // (CLAUDE.md "Table search UX") — same wiring as Transfers.
  const filters = useUrlFilterState({ q: "" });
  const q = filters.params.q;

  const { data, isFetching, isError, error, refetch } = useCustomerSearch(q);

  const [exporting, setExporting] = useState(false);

  // Mirror the API: the CSV dump needs customers.update, a merge
  // deletes the loser so it needs customers.delete. Role is not the
  // question — a custom access role can grant or withhold either.
  const canExport = hasPermission("customers", "update");
  const canMerge = hasPermission("customers", "delete");

  // ── Merge-mode state ────────────────────────────────────
  const [mergeMode, setMergeMode] = useState(false);
  // Index 0 = winner, index 1 = loser. Stored as the picked
  // CustomerRow so we can render side-by-side details without
  // re-querying.
  const [picks, setPicks] = useState<CustomerRow[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const toast = useToast();

  function exitMergeMode() {
    setMergeMode(false);
    setPicks([]);
    setConfirmOpen(false);
    setMergeError(null);
  }

  function togglePick(row: CustomerRow) {
    setPicks((curr) => {
      const idx = curr.findIndex((p) => p.id === row.id);
      if (idx >= 0) {
        return curr.filter((p) => p.id !== row.id);
      }
      if (curr.length >= 2) return curr;
      return [...curr, row];
    });
  }

  function swapPicks() {
    setPicks((curr) =>
      curr.length === 2 ? [curr[1], curr[0]] : curr,
    );
  }

  async function onExport() {
    setExporting(true);
    try {
      const today = todayIso();
      await downloadCsv(
        "/api/v2/customers/export.csv",
        `customers_${today}.csv`,
      );
    } finally {
      setExporting(false);
    }
  }

  async function onMerge() {
    if (picks.length !== 2) return;
    const [winner, loser] = picks;
    setMerging(true);
    setMergeError(null);
    try {
      const result = await mergeCustomers(winner.id, loser.id);
      toast({
        message: result.transfers_repointed
          ? tn("customer.mergedRepointed", result.transfers_repointed, fmtNumber, {
              loser: loser.full_name, winner: winner.full_name,
            })
          : t("customer.merged", { loser: loser.full_name, winner: winner.full_name }),
        tone: "success",
      });
      exitMergeMode();
      await refetch();
    } catch (e) {
      setMergeError(
        apiErrorMessage(e, t("customer.mergeFailed")),
      );
    } finally {
      setMerging(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageCrumbs />
        <PageHeader title={navWord("Customers")} />
        <Empty>{t("customer.signIn")}</Empty>
      </PageShell>
    );
  }

  const actions = (
    <>
      {canMerge && (
        mergeMode ? (
          <Button
            tone="secondary"
            size="sm"
            onClick={exitMergeMode}
            disabled={merging}
          >
            {t("customer.cancelMerge")}
          </Button>
        ) : (
          <Button
            tone="secondary"
            size="sm"
            onClick={() => setMergeMode(true)}
          >
            {t("customer.mergeDuplicates")}
          </Button>
        )
      )}
      {canExport && (
        <Button
          tone="secondary"
          size="sm"
          busy={exporting}
          disabled={exporting}
          onClick={onExport}
        >
          {exporting ? t("customer.exporting") : t("customer.exportCsv")}
        </Button>
      )}
    </>
  );

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Customers")}
        subtitle={q.length >= 2
          ? data
            ? `${tn("customer.matchCount", data.matches.length, fmtNumber)} · ${
                tn("customer.suggestionCount", data.suggestions.length, fmtNumber)}`
            : t("transfer.searching")
          : t("customer.typeTwo")}
        actions={actions}
      />

      {mergeMode && (
        <MergeBanner
          picks={picks}
          onSwap={swapPicks}
          onClear={() => setPicks([])}
          onProceed={() => setConfirmOpen(true)}
        />
      )}

      <Card style={{ marginBottom: space.lg }}>
        <Field label={t("transfer.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("customer.searchPlaceholder")}
          />
        </Field>
        {isFetching && <Loading />}
      </Card>

      {isError && (
        <ErrorState
          message={apiErrorMessage(error, t("customer.searchFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && data.matches.length > 0 && (
        <Section title={t("transfer.matches")}>
          <Card>
            <CustomerTable
              rows={data.matches}
              mergeMode={mergeMode}
              picks={picks}
              onTogglePick={togglePick}
            />
          </Card>
        </Section>
      )}

      {data && data.suggestions.length > 0 && (
        <Section title={t("transfer.suggestions")}>
          <Card>
            <CustomerTable
              rows={data.suggestions}
              mergeMode={mergeMode}
              picks={picks}
              onTogglePick={togglePick}
            />
          </Card>
        </Section>
      )}

      {data &&
        data.matches.length === 0 &&
        data.suggestions.length === 0 &&
        q.length >= 2 &&
        !isFetching && (
          <EmptyState title={t("customer.noMatch", { q })} />
        )}

      {confirmOpen && picks.length === 2 && (
        <MergeConfirmModal
          winner={picks[0]}
          loser={picks[1]}
          busy={merging}
          error={mergeError}
          onSwap={swapPicks}
          onCancel={() => {
            setConfirmOpen(false);
            setMergeError(null);
          }}
          onConfirm={onMerge}
        />
      )}
    </PageShell>
  );
}


function MergeBanner({
  picks, onSwap, onClear, onProceed,
}: {
  picks: CustomerRow[];
  onSwap: () => void;
  onClear: () => void;
  onProceed: () => void;
}) {
  const t = useT();
  return (
    <Card style={{ marginBottom: space.lg }}>
      <div className={styles.mergeBanner}>
        <div>
          <strong>{t("customer.mergeMode")}</strong>
          <p className={styles.mergeBannerCopy}>
            {t("customer.mergeHelp")}
          </p>
          <p className={styles.mergeBannerCopy}>
            {picks.length === 0 && t("customer.selectedNone")}
            {picks.length === 1 && tNodes("customer.selectedOne", {
              winner: <strong>{picks[0].full_name}</strong>,
            })}
            {picks.length === 2 && tNodes("customer.selectedTwo", {
              winner: <strong>{picks[0].full_name}</strong>,
              loser: <strong>{picks[1].full_name}</strong>,
            })}
          </p>
        </div>
        <div className={styles.mergeBannerActions}>
          {picks.length === 2 && (
            <>
              <Button tone="secondary" size="sm" onClick={onSwap}>
                {t("customer.swap")}
              </Button>
              <Button tone="primary" size="sm" onClick={onProceed}>
                {t("customer.reviewMerge")}
              </Button>
            </>
          )}
          {picks.length > 0 && (
            <Button tone="secondary" size="sm" onClick={onClear}>
              {t("customer.clearSelection")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}


function MergeConfirmModal({
  winner, loser, busy, error, onSwap, onCancel, onConfirm,
}: {
  winner: CustomerRow;
  loser:  CustomerRow;
  busy:   boolean;
  error:  string | null;
  onSwap:    () => void;
  onCancel:  () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <Modal
      open={true}
      onClose={onCancel}
      title={t("customer.mergeTitle")}
      size="lg"
      disabled={busy}
      actions={
        <>
          <Button tone="secondary" onClick={onSwap} disabled={busy}>
            {t("customer.swap")}
          </Button>
          <div style={{ flex: 1 }} />
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button tone="primary" busy={busy} disabled={busy} onClick={onConfirm}>
            {busy ? t("customer.merging") : t("customer.merge")}
          </Button>
        </>
      }
    >
      <p className={styles.modalLead}>
        {t("customer.mergeLead")}
      </p>
      <div className={styles.modalGrid}>
        <MergeColumn label={t("customer.winnerKept")} customer={winner} kept />
        <MergeColumn label={t("customer.loserDeleted")} customer={loser} kept={false} />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}


function MergeColumn({
  label, customer, kept,
}: {
  label: string;
  customer: CustomerRow;
  kept: boolean;
}) {
  const t = useT();
  return (
    <div className={kept ? styles.mergeColKept : styles.mergeColDropped}>
      <p className={styles.mergeColLabel}>{label}</p>
      <p className={styles.mergeColName}>{customer.full_name}</p>
      <dl className={styles.mergeColDetails}>
        <dt>{t("transfer.phone")}</dt>
        <dd>
          {customer.phone_country} {maskPhone(customer.phone_number)}
        </dd>
        <dt>{t("customer.dob")}</dt>
        <dd>{customer.dob || "—"}</dd>
        <dt>{t("transfer.address")}</dt>
        <dd>{customer.address || "—"}</dd>
        <dt>{t("customer.homeStore")}</dt>
        <dd>{customer.home_store_name || t("customer.thisStore")}</dd>
      </dl>
    </div>
  );
}


function CustomerTable({
  rows, mergeMode, picks, onTogglePick,
}: {
  rows: CustomerRow[];
  mergeMode: boolean;
  picks: CustomerRow[];
  onTogglePick: (row: CustomerRow) => void;
}) {
  const t = useT();
  const columns = [
    t("transfer.name"), t("transfer.phone"), t("customer.dob"),
    t("transfer.address"), t("customer.homeStore"),
  ];
  const headers = mergeMode ? [t("customer.pick"), ...columns] : columns;
  return (
    <Table>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h} style={thStyle}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => {
          const picked = picks.find((p) => p.id === c.id);
          const disabled = !picked && picks.length >= 2;
          return (
            <tr key={c.id} className={picked ? styles.rowPicked : undefined}>
              {mergeMode && (
                <td style={tdStyle}>
                  <Checkbox
                    checked={!!picked}
                    disabled={disabled}
                    onChange={() => onTogglePick(c)}
                    aria-describedby={undefined}
                  >
                    <span className="sr-only">{t("customer.selectForMerge", { name: c.full_name })}</span>
                  </Checkbox>
                </td>
              )}
              <td style={tdStyle}>
                <strong>{c.full_name}</strong>
                {picked && (
                  <span className={styles.pickedTag}>
                    {" "}· {picks[0]?.id === c.id ? t("customer.winner") : t("customer.loser")}
                  </span>
                )}
              </td>
              <td style={tdStyle}>
                <span
                  className={styles.phone}
                  title={t("customer.fullNumberTip")}
                >
                  {c.phone_country} {maskPhone(c.phone_number)}
                </span>
              </td>
              <td style={tdStyle}>
                <span className={styles.dob}>
                  {c.dob || "—"}
                </span>
              </td>
              <td style={tdStyle}>{c.address || "—"}</td>
              <td style={tdStyle}>
                <span className={styles.muted}>
                  {c.home_store_name || t("customer.thisStore")}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

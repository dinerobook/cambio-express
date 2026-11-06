import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  claimTicket, releaseTicket, TICKET_CATEGORIES, TICKET_STATUSES, TICKET_STATUS_TONES,
  ticketCategoryLabel, ticketStatusLabel, updateTicket, useAllTickets, type TicketRow,
} from "../api/support";
import { useSuperadminStores } from "../api/superadmin";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { TicketThread } from "../components/TicketThread";
import { apiErrorMessage } from "../lib/api";
import {
  Alert, AppLink, Button, Card, EmptyState, ErrorState,
  Field, Input, Loading, PageHeader, PageShell, Pager, Pill, Select,
  useToast,
} from "../components/ui";
import styles from "./SuperadminTickets.module.css";
import { formatDateTime } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";


const PRIORITY_TONES: Record<string, "negative" | "warning" | "info" | "neutral"> = {
  P1: "negative",
  P2: "warning",
  P3: "info",
  P4: "neutral",
};


// Filters live in the URL (shareable, survive a reload); the search
// box is debounced 300 ms with the 2-char minimum every table search
// in the SPA uses (CLAUDE.md "Table search UX").
export default function SuperadminTickets() {
  const t = useT();
  const filters = useUrlFilterState(
    { q: "", status: "", category: "", store_id: "" },
    { pageSizeKey: "superadmin-tickets" },
  );
  const stores = useSuperadminStores();
  const tickets = useAllTickets({
    q: filters.params.q,
    status: filters.params.status,
    category: filters.params.category,
    store_id: filters.params.store_id,
    page: filters.page,
    perPage: filters.perPage,
  });

  return (
    <PageShell>
      <PageCrumbs />
      <PageHeader
        title={navWord("Tickets")}
        subtitle={
          tickets.data
            ? tn(
              filters.params.store_id || filters.params.q ? "saTix.matching" : "saTix.tickets",
              tickets.data.total, fmtNumber,
            )
            : "—"
        }
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              aria-label={t("saTix.searchLabel")}
              placeholder={t("saTix.search")}
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              aria-label={t("saTix.store")}
              value={filters.params.store_id}
              onChange={(e) => filters.setParam("store_id", e.target.value)}
            >
              <option value="">{t("saTix.allStores")}</option>
              {(stores.data?.rows ?? []).map((s) => (
                <option key={s.store_id} value={String(s.store_id)}>{s.name}</option>
              ))}
            </Select>
            <Select
              aria-label={t("common.status")}
              value={filters.params.status}
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              <option value="">{t("saTix.allStatuses")}</option>
              {TICKET_STATUSES.map((s) => <option key={s.value} value={s.value}>{t(s.label)}</option>)}
            </Select>
            <Select
              aria-label={t("support.colCategory")}
              value={filters.params.category}
              onChange={(e) => filters.setParam("category", e.target.value)}
            >
              <option value="">{t("saTix.allCategories")}</option>
              {TICKET_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{t(c.label)}</option>)}
            </Select>
          </div>
        )}
      />

      {tickets.isLoading && <Loading />}
      {tickets.isError && (
        <ErrorState
          message={t("support.loadFailed")}
          onRetry={() => { void tickets.refetch(); }}
        />
      )}

      {tickets.data && tickets.data.tickets.length === 0 && (
        <EmptyState title={t("saTix.empty")} />
      )}

      {tickets.data && tickets.data.tickets.map((row) => (
        <TicketCard key={row.id} ticket={row} />
      ))}

      {tickets.data && tickets.data.tickets.length > 0 && (
        <Pager
          page={tickets.data.page}
          totalPages={tickets.data.total_pages}
          onPage={filters.setPage}
          total={tickets.data.total}
          pageRows={tickets.data.tickets.length}
          perPage={filters.perPage}
          onPerPage={filters.setPerPage}
        />
      )}
    </PageShell>
  );
}

function TicketCard({ ticket: tk }: { ticket: TicketRow }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  // Collapsed by default — expanding shows the conversation thread
  // (which owns replies) plus the status/priority controls.
  const [expanded, setExpanded] = useState(false);
  const [newStatus, setNewStatus] = useState(tk.status);
  const [newPriority, setNewPriority] = useState(tk.priority || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = getCurrentIdentity();
  const claimedByMe =
    tk.assigned_to_user_id != null &&
    tk.assigned_to_user_id === identity?.user_id;

  async function onClaimToggle() {
    setBusy(true);
    setError(null);
    try {
      if (claimedByMe) {
        await releaseTicket(tk.id);
        toast({ message: t("saTix.released"), tone: "success" });
      } else {
        await claimTicket(tk.id);
        toast({ message: t("saTix.claimed"), tone: "success" });
      }
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("saTix.claimFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (newStatus !== tk.status) body.status = newStatus;
      if (newPriority && newPriority !== (tk.priority || "")) body.priority = newPriority;
      if (Object.keys(body).length > 0) {
        await updateTicket(tk.id, body);
        void qc.invalidateQueries({ queryKey: ["tickets"] });
        toast({ message: t("saTix.updated"), tone: "success" });
      }
    } catch (err) {
      setError(apiErrorMessage(err, t("saTix.updateFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.cardInner}>
        <div className={styles.headerRow}>
          <div className={styles.headerLeft}>
            <div className={styles.titleRow}>
              <span className={styles.subject}>{tk.subject}</span>
              {tk.unread_count > 0 && (
                <Pill tone="negative" dot>
                  {tn("saTix.new", tk.unread_count, fmtNumber)}
                </Pill>
              )}
              <Pill tone={TICKET_STATUS_TONES[tk.status] ?? "neutral"}>
                {ticketStatusLabel(tk.status)}
              </Pill>
              {tk.priority && (
                <Pill tone={PRIORITY_TONES[tk.priority] ?? "neutral"}>
                  {tk.priority}
                </Pill>
              )}
              {tk.assigned_to_name && (
                <Pill tone={claimedByMe ? "success" : "info"}>
                  {claimedByMe ? t("saTix.yours") : tk.assigned_to_name}
                </Pill>
              )}
            </div>
            <div className={styles.meta}>
              {tk.submitted_by} ·{" "}
              <AppLink to={`/superadmin/stores/${tk.store_id}`}>
                {tk.store_name || t("saTix.storeNo", { id: tk.store_id })}
              </AppLink>
              {" "}· {formatDateTime(tk.created_at)}
              {" · "}
              <span className={styles.metaCat}>{ticketCategoryLabel(tk.category)}</span>
            </div>
          </div>
          <div className={styles.headerActions}>
            {/* Claim = "I'm working this" - visible to the whole
                platform team so nobody double-handles a ticket. */}
            {(tk.assigned_to_user_id == null || claimedByMe) && (
              <Button
                tone="secondary" size="sm" busy={busy} disabled={busy}
                onClick={() => { void onClaimToggle(); }}
              >
                {claimedByMe ? t("saTix.release") : t("saTix.claim")}
              </Button>
            )}
            <Button tone="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? t("saTix.collapse") : t("saTix.openConversation")}
            </Button>
          </div>
        </div>

        {!expanded && <p className={styles.body}>{tk.body}</p>}

        {error && <Alert tone="error">{error}</Alert>}

        {expanded && (
          <>
            {/* Replies live in the thread (staff replies dual-write
                the legacy admin_reply column server-side). */}
            <TicketThread ticket={tk} viewerKind="staff" />

            <form onSubmit={onSave} className={styles.formInner}>
              <div className={styles.formGrid}>
                <Field label={t("common.status")}>
                  <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                    {TICKET_STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>{t(s.label)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("saTix.priority")}>
                  <Select value={newPriority} onChange={(e) => setNewPriority(e.target.value)}>
                    <option value="">{t("saTix.none")}</option>
                    <option value="P1">{t("saTix.p1")}</option>
                    <option value="P2">{t("saTix.p2")}</option>
                    <option value="P3">{t("saTix.p3")}</option>
                    <option value="P4">{t("saTix.p4")}</option>
                  </Select>
                </Field>
                <div className={styles.formActions}>
                  <Button
                    type="submit" tone="secondary" busy={busy}
                    disabled={
                      busy ||
                      (newStatus === tk.status &&
                        (newPriority || "") === (tk.priority || ""))
                    }
                  >
                    {busy ? t("common.saving") : t("saTix.updateStatus")}
                  </Button>
                </div>
              </div>
            </form>
          </>
        )}
      </div>
    </Card>
  );
}

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  claimTicket, releaseTicket, TICKET_STATUS_TONES, updateTicket,
  useAllTickets, type TicketRow,
} from "../api/support";
import { useSuperadminStores } from "../api/superadmin";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { TicketThread } from "../components/TicketThread";
import { apiErrorMessage } from "../lib/api";
import {
  Alert, AppLink, Breadcrumbs, Button, Card, EmptyState, ErrorState,
  Field, Input, Loading, PageHeader, PageShell, Pager, Pill, Select,
  useToast,
} from "../components/ui";
import styles from "./SuperadminTickets.module.css";
import { formatDateTime } from "../lib/datetime";

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "question", label: "Question" },
  { value: "feedback", label: "Feedback" },
];

const STATUSES = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];


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
  const filters = useUrlFilterState({ q: "", status: "", category: "", store_id: "" });
  const stores = useSuperadminStores();
  const tickets = useAllTickets({
    q: filters.params.q,
    status: filters.params.status,
    category: filters.params.category,
    store_id: filters.params.store_id,
    page: filters.page,
  });

  return (
    <PageShell>
      <Breadcrumbs crumbs={[
        { label: "Superadmin" },
        { label: "Support tickets" },
      ]} />
      <PageHeader
        title="Support tickets"
        subtitle={
          tickets.data
            ? `${tickets.data.total.toLocaleString()} ${tickets.data.total === 1 ? "ticket" : "tickets"}${filters.params.store_id || filters.params.q ? " matching" : " across all stores"}`
            : "—"
        }
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              aria-label="Search tickets"
              placeholder="Search subject, sender, store…"
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              aria-label="Store"
              value={filters.params.store_id}
              onChange={(e) => filters.setParam("store_id", e.target.value)}
            >
              <option value="">All stores</option>
              {(stores.data?.rows ?? []).map((s) => (
                <option key={s.store_id} value={String(s.store_id)}>{s.name}</option>
              ))}
            </Select>
            <Select
              aria-label="Status"
              value={filters.params.status}
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
            <Select
              aria-label="Category"
              value={filters.params.category}
              onChange={(e) => filters.setParam("category", e.target.value)}
            >
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          </div>
        )}
      />

      {tickets.isLoading && <Loading />}
      {tickets.isError && (
        <ErrorState
          message="Could not load tickets."
          onRetry={() => { void tickets.refetch(); }}
        />
      )}

      {tickets.data && tickets.data.tickets.length === 0 && (
        <EmptyState title="No tickets match the current filters." />
      )}

      {tickets.data && tickets.data.tickets.map((t) => (
        <TicketCard key={t.id} ticket={t} />
      ))}

      {tickets.data && tickets.data.total_pages > 1 && (
        <Pager
          page={tickets.data.page}
          totalPages={tickets.data.total_pages}
          onPage={filters.setPage}
        />
      )}
    </PageShell>
  );
}

function TicketCard({ ticket: t }: { ticket: TicketRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Collapsed by default — expanding shows the conversation thread
  // (which owns replies) plus the status/priority controls.
  const [expanded, setExpanded] = useState(false);
  const [newStatus, setNewStatus] = useState(t.status);
  const [newPriority, setNewPriority] = useState(t.priority || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const identity = getCurrentIdentity();
  const claimedByMe =
    t.assigned_to_user_id != null &&
    t.assigned_to_user_id === identity?.user_id;

  async function onClaimToggle() {
    setBusy(true);
    setError(null);
    try {
      if (claimedByMe) {
        await releaseTicket(t.id);
        toast({ message: "Claim released.", tone: "success" });
      } else {
        await claimTicket(t.id);
        toast({ message: "Ticket claimed - it's yours.", tone: "success" });
      }
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      setError(apiErrorMessage(err, "Could not update the claim."));
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
      if (newStatus !== t.status) body.status = newStatus;
      if (newPriority && newPriority !== (t.priority || "")) body.priority = newPriority;
      if (Object.keys(body).length > 0) {
        await updateTicket(t.id, body);
        void qc.invalidateQueries({ queryKey: ["tickets"] });
        toast({ message: "Ticket updated.", tone: "success" });
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Could not update ticket."));
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
              <span className={styles.subject}>{t.subject}</span>
              {t.unread_count > 0 && (
                <Pill tone="negative" dot>
                  {t.unread_count} new
                </Pill>
              )}
              <Pill tone={TICKET_STATUS_TONES[t.status] ?? "neutral"}>
                {t.status.replace("_", " ")}
              </Pill>
              {t.priority && (
                <Pill tone={PRIORITY_TONES[t.priority] ?? "neutral"}>
                  {t.priority}
                </Pill>
              )}
              {t.assigned_to_name && (
                <Pill tone={claimedByMe ? "success" : "info"}>
                  {claimedByMe ? "Yours" : t.assigned_to_name}
                </Pill>
              )}
            </div>
            <div className={styles.meta}>
              {t.submitted_by} ·{" "}
              <AppLink to={`/superadmin/stores/${t.store_id}`}>
                {t.store_name || `Store #${t.store_id}`}
              </AppLink>
              {" "}· {formatDateTime(t.created_at)}
              {" · "}
              <span className={styles.metaCat}>{t.category}</span>
            </div>
          </div>
          <div className={styles.headerActions}>
            {/* Claim = "I'm working this" - visible to the whole
                platform team so nobody double-handles a ticket. */}
            {(t.assigned_to_user_id == null || claimedByMe) && (
              <Button
                tone="secondary" size="sm" busy={busy} disabled={busy}
                onClick={() => { void onClaimToggle(); }}
              >
                {claimedByMe ? "Release" : "Claim"}
              </Button>
            )}
            <Button tone="secondary" size="sm" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Collapse" : "Open conversation"}
            </Button>
          </div>
        </div>

        {!expanded && <p className={styles.body}>{t.body}</p>}

        {error && <Alert tone="error">{error}</Alert>}

        {expanded && (
          <>
            {/* Replies live in the thread (staff replies dual-write
                the legacy admin_reply column server-side). */}
            <TicketThread ticket={t} viewerKind="staff" />

            <form onSubmit={onSave} className={styles.formInner}>
              <div className={styles.formGrid}>
                <Field label="Status">
                  <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </Select>
                </Field>
                <Field label="Priority">
                  <Select value={newPriority} onChange={(e) => setNewPriority(e.target.value)}>
                    <option value="">— None —</option>
                    <option value="P1">P1 — Critical</option>
                    <option value="P2">P2 — High</option>
                    <option value="P3">P3 — Medium</option>
                    <option value="P4">P4 — Low</option>
                  </Select>
                </Field>
                <div className={styles.formActions}>
                  <Button
                    type="submit" tone="secondary" busy={busy}
                    disabled={
                      busy ||
                      (newStatus === t.status &&
                        (newPriority || "") === (t.priority || ""))
                    }
                  >
                    {busy ? "Saving…" : "Update status"}
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

import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { createTicket, TICKET_STATUS_TONES, useMyTickets, type TicketRow } from "../api/support";
import { TicketThread } from "../components/TicketThread";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Alert, Button, Card, type DataColumn, DataTable, Field, FormActions,
  Input, PageHeader, PageShell, Pill, Section, Select, Textarea, useToast,
} from "../components/ui";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./SupportTickets.module.css";
import { formatDateTime } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtCount } from "../lib/formatters";

const CATEGORIES = [
  { value: "bug", label: "Bug report" },
  { value: "feature", label: "Feature request" },
  { value: "question", label: "Question" },
  { value: "feedback", label: "General feedback" },
];

const COLUMNS: DataColumn<TicketRow>[] = [
  {
    key: "subject", header: "Subject",
    render: (t) => (t.unread_count > 0 ? (
      <span className={styles.unreadSubject}>
        {t.subject}
        <span
          className={styles.unreadBadge}
          title={`${fmtCount(t.unread_count, "new reply", "new replies")}`}
        >
          {t.unread_count}
        </span>
      </span>
    ) : t.subject),
  },
  {
    key: "category", header: "Category",
    render: (t) => CATEGORIES.find((c) => c.value === t.category)?.label ?? t.category,
  },
  {
    key: "status", header: "Status",
    render: (t) => (
      <Pill tone={TICKET_STATUS_TONES[t.status] ?? "neutral"}>
        {t.status.replace("_", " ")}
      </Pill>
    ),
  },
  { key: "created", header: "Created", render: (t) => formatDateTime(t.created_at) },
];

export default function SupportTickets() {
  const identity = getCurrentIdentity();
  if (identity?.role === "superadmin") {
    return <Navigate to="/superadmin/tickets" replace />;
  }
  return <SupportTicketsInner />;
}

function SupportTicketsInner() {
  const filters = useUrlFilterState({}, { pageSizeKey: "support-tickets" });
  const tickets = useMyTickets({ page: filters.page, perPage: filters.perPage });
  // The ticket whose conversation is open under its row.
  const [openId, setOpenId] = useState<number | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState("question");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A typed ticket is the work to protect; the category alone is not.
  const guard = useUnsavedGuard(
    showForm && Boolean(subject.trim() || body.trim()) && !busy,
    { message: "You have a ticket you haven't submitted. Leave without submitting?" },
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTicket({ category, subject: subject.trim(), body: body.trim() });
      setSubject("");
      setBody("");
      setShowForm(false);
      toast({
        message: "Ticket submitted — we'll get back to you soon.",
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      setError(apiErrorMessage(err, "Could not submit ticket."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="56rem">
      <PageCrumbs />
      <PageHeader
        title="Support"
        subtitle="Report bugs, request features, or ask questions."
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Cancel" : "+ New ticket"}
          </Button>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {showForm && (
        <Card>
          <Section title="Submit a ticket">
            <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div className={styles.formGrid}>
                <Field label="Category">
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Subject">
                  <Input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Brief summary"
                    maxLength={200}
                    required
                  />
                </Field>
              </div>
              <Field label="Description">
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Describe the issue, idea, or question in detail…"
                  rows={5}
                  maxLength={5000}
                  required
                />
              </Field>
              <FormActions guard={guard}>
                <Button type="submit" busy={busy} disabled={busy || !subject.trim() || !body.trim()}>
                  {busy ? "Submitting…" : "Submit ticket"}
                </Button>
              </FormActions>
            </form>
          </Section>
        </Card>
      )}

      {/* While the new-ticket form is open an empty list says nothing. */}
      {!(showForm && tickets.data?.tickets.length === 0) && (
        <Card>
          <DataTable
            columns={COLUMNS}
            rows={tickets.data?.tickets}
            rowKey={(t) => t.id}
            onRowClick={(t) => setOpenId((cur) => (cur === t.id ? null : t.id))}
            rowLabel={(t) => `Open ticket ${t.subject}`}
            expandedRow={(t) => (t.id === openId
              ? <TicketThread ticket={t} viewerKind="user" />
              : null)}
            isLoading={tickets.isLoading}
            isError={tickets.isError}
            error={tickets.error}
            errorMessage="Could not load tickets."
            onRetry={() => { void tickets.refetch(); }}
            emptyTitle="No tickets yet"
            emptyBody='Click "+ New ticket" to submit your first one.'
            page={tickets.data && {
              page: tickets.data.page,
              totalPages: tickets.data.total_pages,
              total: tickets.data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
          />
        </Card>
      )}
    </PageShell>
  );
}

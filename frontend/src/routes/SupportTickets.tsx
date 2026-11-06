import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  createTicket, TICKET_CATEGORIES, TICKET_STATUS_TONES, ticketCategoryLabel, ticketStatusLabel,
  useMyTickets, type TicketRow,
} from "../api/support";
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
import { t, tn, useT } from "../i18n";

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<TicketRow>[] => [
  {
    key: "subject", header: t("support.colSubject"),
    render: (t) => (t.unread_count > 0 ? (
      <span className={styles.unreadSubject}>
        {t.subject}
        <span
          className={styles.unreadBadge}
          title={tn("support.newReplies", t.unread_count)}
        >
          {t.unread_count}
        </span>
      </span>
    ) : t.subject),
  },
  {
    key: "category", header: t("support.colCategory"),
    render: (row) => ticketCategoryLabel(row.category),
  },
  {
    key: "status", header: t("common.status"),
    render: (row) => (
      <Pill tone={TICKET_STATUS_TONES[row.status] ?? "neutral"}>
        {ticketStatusLabel(row.status)}
      </Pill>
    ),
  },
  { key: "created", header: t("support.colCreated"), render: (row) => formatDateTime(row.created_at) },
];

export default function SupportTickets() {
  const identity = getCurrentIdentity();
  if (identity?.role === "superadmin") {
    return <Navigate to="/superadmin/tickets" replace />;
  }
  return <SupportTicketsInner />;
}

function SupportTicketsInner() {
  useT(); // re-render on a language switch
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
    { message: t("support.unsaved") },
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
        message: t("support.submitted"),
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: ["tickets"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("support.submitFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="56rem">
      <PageCrumbs />
      <PageHeader
        title={t("ticket.support")}
        subtitle={t("support.subtitle")}
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? t("common.cancel") : t("support.newTicket")}
          </Button>
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {showForm && (
        <Card>
          <Section title={t("support.formTitle")}>
            <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div className={styles.formGrid}>
                <Field label={t("support.colCategory")}>
                  <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    {TICKET_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{t(c.label)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t("support.colSubject")}>
                  <Input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder={t("support.subjectPlaceholder")}
                    maxLength={200}
                    required
                  />
                </Field>
              </div>
              <Field label={t("support.description")}>
                <Textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t("support.descriptionPlaceholder")}
                  rows={5}
                  maxLength={5000}
                  required
                />
              </Field>
              <FormActions guard={guard}>
                <Button type="submit" busy={busy} disabled={busy || !subject.trim() || !body.trim()}>
                  {busy ? t("support.submitting") : t("support.submit")}
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
            columns={columns()}
            rows={tickets.data?.tickets}
            rowKey={(row) => row.id}
            onRowClick={(row) => setOpenId((cur) => (cur === row.id ? null : row.id))}
            rowLabel={(row) => t("support.openTicket", { subject: row.subject })}
            expandedRow={(row) => (row.id === openId
              ? <TicketThread ticket={row} viewerKind="user" />
              : null)}
            isLoading={tickets.isLoading}
            isError={tickets.isError}
            error={tickets.error}
            errorMessage={t("support.loadFailed")}
            onRetry={() => { void tickets.refetch(); }}
            emptyTitle={t("support.emptyTitle")}
            emptyBody={t("support.emptyBody")}
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

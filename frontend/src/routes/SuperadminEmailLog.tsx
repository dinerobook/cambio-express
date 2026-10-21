import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { EMAIL_EVENT_TONES } from "../api/superadmin";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  formatDate, formatTimestamp,
} from "../lib/datetime";
import {
  Card, DataTable, Input, PageHeader, PageShell, Pill,
  Section, Select, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminEmailLog.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";

interface EmailEventRow {
  id: number;
  to_addr: string;
  event_type: string;
  bounce_type: string;
  message_id: string;
  created_at: string;
}

interface SuppressedRow {
  user_id: number;
  username: string;
  email: string;
  bounced_at: string;
}

interface EmailLogData {
  rows: EmailEventRow[];
  total: number;
  page: number;
  total_pages: number;
  suppressed: SuppressedRow[];
}

const EVENT_TYPES = [
  { value: "", label: "All events" },
  { value: "email.sent", label: "Sent" },
  { value: "email.delivered", label: "Delivered" },
  { value: "email.bounced", label: "Bounced" },
  { value: "email.complained", label: "Complained" },
  { value: "email.opened", label: "Opened" },
  { value: "email.clicked", label: "Clicked" },
];

const COLUMNS: DataColumn<EmailEventRow>[] = [
  { key: "to", header: "Recipient", render: (e) => e.to_addr },
  {
    key: "event", header: "Event",
    render: (e) => (
      <Pill tone={EMAIL_EVENT_TONES[e.event_type] ?? "neutral"}>
        {e.event_type.replace("email.", "")}
      </Pill>
    ),
  },
  {
    key: "bounce", header: "Bounce",
    render: (e) => (e.bounce_type
      ? <Pill tone="negative">{e.bounce_type}</Pill>
      : <span className={styles.monoMuted}>—</span>),
  },
  {
    key: "message", header: "Message ID",
    render: (e) => (
      <span className={styles.monoMuted}>
        {e.message_id ? e.message_id.slice(0, 16) + "…" : "—"}
      </span>
    ),
  },
  {
    key: "time", header: "Time",
    render: (e) => <span className={styles.monoMuted}>{formatTimestamp(e.created_at)}</span>,
  },
];

function useEmailLog(opts: { q?: string; event_type?: string; page?: number; perPage?: number }) {
  const identity = getCurrentIdentity();
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.event_type) params.set("event_type", opts.event_type);
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const qs = params.toString() ? `?${params}` : "";
  return useQuery<EmailLogData>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "email-log", opts.q, opts.event_type, opts.page, opts.perPage],
    queryFn: () => api<EmailLogData>(`/api/v2/superadmin/email-log${qs}`),
    placeholderData: (prev) => prev,
  });
}

export default function SuperadminEmailLog() {
  // Filters live in the URL; the search box applies as you type
  // (300ms debounce, 2-char minimum), the event type at once.
  const filters = useUrlFilterState({ q: "", event_type: "" }, { pageSizeKey: "email-log" });
  const q = filters.params.q.trim();
  const eventType = filters.params.event_type;
  const { data, isLoading, isError, error, refetch } = useEmailLog({
    q: q || undefined, event_type: eventType || undefined,
    page: filters.page, perPage: filters.perPage,
  });

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Email log"
        subtitle={data ? `${fmtNumber(data.total)} events` : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder="Search email address…"
              aria-label="Search email address"
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={eventType}
              aria-label="Event"
              onChange={(e) => filters.setParam("event_type", e.target.value)}
            >
              {EVENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </Select>
          </div>
        )}
      />

      <Card>
        <DataTable
          columns={COLUMNS}
          rows={data?.rows}
          rowKey={(e) => e.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="No email events match the filters."
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>

      {data && (
        <>
          {data.suppressed.length > 0 && (
            <Section title={`Suppressed addresses (${data.suppressed.length})`}>
              <Card>
                <div className={styles.suppressedList}>
                  {data.suppressed.map((s) => (
                    <div key={s.user_id} className={styles.suppressedRow}>
                      <div>
                        <strong>{s.username}</strong>
                        <span className={styles.monoMuted}> · {s.email}</span>
                      </div>
                      <span className={styles.monoMuted}>
                        Bounced {formatDate(s.bounced_at)}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            </Section>
          )}
        </>
      )}
    </PageShell>
  );
}

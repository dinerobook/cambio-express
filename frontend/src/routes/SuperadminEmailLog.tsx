import { useQuery } from "@tanstack/react-query";

import { api } from "../lib/api";
import { EMAIL_EVENT_TONES } from "../api/superadmin";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  csvTimestamp, formatDate, formatTimestamp,
} from "../lib/datetime";
import {
  Card, DataTable, Input, PageHeader, PageShell, Pill,
  Section, Select, type DataColumn,
} from "../components/ui";
import styles from "./SuperadminEmailLog.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import type { components } from "../api/openapi";
import { en } from "../i18n/en";
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

type EmailEventRow = components["schemas"]["SuperadminEmailEventRow"];
type EmailLogData = components["schemas"]["SuperadminEmailLogResponse"];

const EVENT_TYPES: { value: string; label: MessageKey }[] = [
  { value: "", label: "saEmail.allEvents" },
  { value: "email.sent", label: "saEmail.ev.sent" },
  { value: "email.delivered", label: "saEmail.ev.delivered" },
  { value: "email.bounced", label: "saEmail.ev.bounced" },
  { value: "email.complained", label: "saEmail.ev.complained" },
  { value: "email.opened", label: "saEmail.ev.opened" },
  { value: "email.clicked", label: "saEmail.ev.clicked" },
];

/** "email.bounced" → "Bounced"; an event type the SPA doesn't list
 *  shows as sent, without its "email." prefix. */
function eventLabel(eventType: string): string {
  const short = eventType.replace("email.", "");
  const key = `saEmail.ev.${short}`;
  return Object.hasOwn(en, key) ? translate(key as MessageKey) : short;
}

function emailColumns(): DataColumn<EmailEventRow>[] {
  const t = translate;
  return [
  { key: "to", header: t("saEmail.colRecipient"), render: (e) => e.to_addr, csv: (e) => e.to_addr },
  {
    key: "event", header: t("saEmail.colEvent"),
    render: (e) => (
      <Pill tone={EMAIL_EVENT_TONES[e.event_type] ?? "neutral"}>
        {eventLabel(e.event_type)}
      </Pill>
    ),
    csv: (e) => eventLabel(e.event_type),
  },
  {
    key: "bounce", header: t("saEmail.colBounce"),
    render: (e) => (e.bounce_type
      ? <Pill tone="negative">{e.bounce_type}</Pill>
      : <span className={styles.monoMuted}>—</span>),
    csv: (e) => e.bounce_type,
  },
  {
    key: "message", header: t("saEmail.colMessage"),
    render: (e) => (
      <span className={styles.monoMuted}>
        {e.message_id ? e.message_id.slice(0, 16) + "…" : "—"}
      </span>
    ),
    // The file carries the whole id the cell shortens.
    csv: (e) => e.message_id,
  },
  {
    key: "time", header: t("saEmail.colTime"),
    render: (e) => <span className={styles.monoMuted}>{formatTimestamp(e.created_at)}</span>,
    csv: (e) => csvTimestamp(e.created_at),
  },
  ];
}

interface EmailLogQuery { q?: string; event_type?: string; page?: number; perPage?: number }

/** One page of the email log — the request the page and its CSV
 *  export both make. */
function fetchEmailLog(opts: EmailLogQuery): Promise<EmailLogData> {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.event_type) params.set("event_type", opts.event_type);
  if (opts.page && opts.page > 1) params.set("page", String(opts.page));
  if (opts.perPage) params.set("per_page", String(opts.perPage));
  const qs = params.toString() ? `?${params}` : "";
  return api<EmailLogData>(`/api/v2/superadmin/email-log${qs}`);
}

function useEmailLog(opts: EmailLogQuery) {
  const identity = getCurrentIdentity();
  return useQuery<EmailLogData>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "email-log", opts.q, opts.event_type, opts.page, opts.perPage],
    queryFn: () => fetchEmailLog(opts),
    placeholderData: (prev) => prev,
  });
}

export default function SuperadminEmailLog() {
  // Filters live in the URL; the search box applies as you type
  // (300ms debounce, 2-char minimum), the event type at once.
  const t = useT();
  const filters = useUrlFilterState({ q: "", event_type: "" }, { pageSizeKey: "email-log" });
  const q = filters.params.q.trim();
  const eventType = filters.params.event_type;
  const listQuery = { q: q || undefined, event_type: eventType || undefined };
  const { data, isLoading, isError, error, refetch } = useEmailLog({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Email log")}
        subtitle={data ? tn("saEmail.events", data.total, fmtNumber) : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder={t("saEmail.search")}
              aria-label={t("saEmail.searchLabel")}
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={eventType}
              aria-label={t("saEmail.colEvent")}
              onChange={(e) => filters.setParam("event_type", e.target.value)}
            >
              {EVENT_TYPES.map((ev) => (
                <option key={ev.value} value={ev.value}>{t(ev.label)}</option>
              ))}
            </Select>
          </div>
        )}
      />

      <Card>
        <DataTable
          columns={emailColumns()}
          rows={data?.rows}
          rowKey={(e) => e.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("saEmail.empty")}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "email-log",
            fetchPage: (page, perPage) => fetchEmailLog({ ...listQuery, page, perPage }),
          }}
        />
      </Card>

      {data && (
        <>
          {data.suppressed.length > 0 && (
            <Section title={t("saEmail.suppressed", { count: fmtNumber(data.suppressed.length) })}>
              <Card>
                <div className={styles.suppressedList}>
                  {data.suppressed.map((s) => (
                    <div key={s.user_id} className={styles.suppressedRow}>
                      <div>
                        <strong>{s.username}</strong>
                        <span className={styles.monoMuted}> · {s.email}</span>
                      </div>
                      <span className={styles.monoMuted}>
                        {t("saEmail.bouncedOn", { date: formatDate(s.bounced_at) })}
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

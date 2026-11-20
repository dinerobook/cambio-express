import { Navigate, useNavigate } from "react-router-dom";

import { useSessionStatus } from "../api/account";
import {
  devFileTypeLabel, useDevFiles, type DevFileRow,
} from "../api/developer";
import {
  AppLink, Card, DataTable, DateInput, InfoTip, Input, KpiCard, KpiGrid,
  PageHeader, PageShell, Pill, Section, Select, tokens, type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { homePathFor } from "../lib/access";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate, formatTimestamp } from "../lib/datetime";
import { fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { t, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";
import styles from "./DeveloperFiles.module.css";

// /app/developer/files — the store's Developer tab (owner,
// 2026-11-20). Only a superadmin signed in AS the store reaches it:
// the sidebar shows it only then (navConfig `impersonation`), anyone
// else is sent home, and the server refuses its routes to them.
//
// Every Passport file the register sent, newest first, starting on
// the ones that did NOT import (the readers could not read them, so
// nothing from them reached any tab). The filters live in the URL,
// so a link opens the exact list. Read only.

// "all" rather than "": the URL drops a filter at its default, and
// the default here is "Not imported".
const STATUSES: { value: string; label: MessageKey }[] = [
  { value: "not_imported", label: "dev.notImported" },
  { value: "imported", label: "dev.imported" },
  { value: "all", label: "dev.statusAll" },
];

const KINDS: { value: string; label: MessageKey }[] = [
  { value: "", label: "dev.kindAll" },
  { value: "journal", label: "dev.kindJournal" },
  { value: "movement", label: "dev.kindMovement" },
  { value: "unknown", label: "dev.kindUnknown" },
];

const MONO = { fontFamily: tokens.fontMono };

// Built during render so the headings follow a language switch.
const columns = (): DataColumn<DevFileRow>[] => [
  {
    key: "file", header: t("dev.colFile"), sortKey: "filename",
    render: (r) => (
      <AppLink to={`/developer/files/${r.id}`} className="ds-link" style={MONO}>
        {r.filename}
      </AppLink>
    ),
  },
  { key: "type", header: t("dev.colType"), render: (r) => devFileTypeLabel(r) },
  {
    key: "day", header: t("dev.colDay"), sortKey: "business_date", sortFirst: "desc",
    render: (r) => (r.business_date ? formatDate(r.business_date) : "—"),
  },
  {
    key: "received", header: t("dev.colReceived"), sortKey: "received", sortFirst: "desc",
    render: (r) => formatTimestamp(r.received_at),
  },
  {
    key: "status", header: t("dev.colStatus"),
    render: (r) => (r.imported
      ? <Pill tone="success">{t("dev.imported")}</Pill>
      : <Pill tone="negative">{t("dev.notImported")}</Pill>),
  },
  {
    key: "reason", header: t("dev.colReason"),
    render: (r) => <span className={styles.reason}>{r.reason || "—"}</span>,
  },
];

export default function DeveloperFiles() {
  useT(); // re-render on a language switch
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const session = useSessionStatus();
  const impersonating = !!session.data?.impersonation;
  const filters = useUrlFilterState({
    q: "", status: "not_imported", kind: "", start: "", end: "",
  }, {
    pageSizeKey: "developer-files",
    defaultSort: { key: "received", direction: "desc" },
  });
  const sort = filters.sort!;
  const status = filters.params.status === "all" ? "" : filters.params.status;
  const list = useDevFiles({
    q: filters.params.q, status, kind: filters.params.kind,
    start: filters.params.start, end: filters.params.end,
    sort: sort.key, direction: sort.direction,
    page: filters.page, perPage: filters.perPage,
  }, impersonating);
  const data = list.data;

  if (session.data && !impersonating) {
    return <Navigate to={homePathFor(identity)} replace />;
  }

  return (
    <PageShell maxWidth="76rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {navWord("Developer")}
            <InfoTip text={t("dev.tip")} />
          </>
        }
        subtitle={t("dev.subtitle", {
          store: session.data?.store_name ?? "",
          id: identity?.store_id ?? "",
        })}
      />

      {data && (
        <KpiGrid>
          <KpiCard label={t("dev.kpiFiles")} value={fmtNumber(data.summary.files)} />
          <KpiCard
            label={t("dev.kpiNotImported")}
            value={fmtNumber(data.summary.not_imported)}
            tone={data.summary.not_imported > 0 ? "negative" : "positive"}
          />
          <KpiCard
            label={t("dev.kpiLast")}
            value={formatTimestamp(data.summary.last_received_at)}
          />
        </KpiGrid>
      )}

      <Section title={t("dev.files")}>
        <Card>
          <DataTable
            toolbar={(
              <>
                <Input
                  type="search"
                  value={filters.draft.q ?? filters.params.q}
                  placeholder={t("dev.searchPlaceholder")}
                  aria-label={t("dev.searchLabel")}
                  onChange={(e) => filters.debounced("q", e.target.value)}
                />
                <Select
                  value={filters.params.status}
                  aria-label={t("dev.statusLabel")}
                  onChange={(e) => filters.setParam("status", e.target.value)}
                >
                  {STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>{t(s.label)}</option>
                  ))}
                </Select>
                <Select
                  value={filters.params.kind}
                  aria-label={t("dev.kindLabel")}
                  onChange={(e) => filters.setParam("kind", e.target.value)}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>{t(k.label)}</option>
                  ))}
                </Select>
                <DateInput
                  value={filters.params.start}
                  aria-label={t("dev.from")}
                  onChange={(e) => filters.setParam("start", e.target.value)}
                />
                <DateInput
                  value={filters.params.end}
                  aria-label={t("dev.to")}
                  onChange={(e) => filters.setParam("end", e.target.value)}
                />
              </>
            )}
            columns={columns()}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/developer/files/${r.id}`)}
            rowLabel={(r) => t("dev.openFile", { file: r.filename })}
            sort={sort}
            isLoading={list.isLoading || !session.data}
            isError={list.isError} error={list.error}
            onRetry={() => { void list.refetch(); }}
            errorMessage={t("dev.loadFailed")}
            emptyTitle={t("dev.empty")}
            emptyBody={t("dev.emptyBody")}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
          />
        </Card>
      </Section>
    </PageShell>
  );
}

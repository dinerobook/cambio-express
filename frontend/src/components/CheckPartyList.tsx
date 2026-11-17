import type { UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import type { PartyListQuery } from "../api/checkCashing";
import { DeskNoStore, DeskPage, DeskPane } from "./DeskPage";
import { PageCrumbs } from "./PageCrumbs";
import {
  ButtonLink, Card, DataTable, Field, Input, PageHeader, TabsBar, TabsButton,
  type DataColumn,
} from "./ui";
import { useT, type MessageKey } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import type { CsvPage } from "../lib/csv";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "../routes/CheckCashing.module.css";

// The check cashing app's two directories, Customers and Companies:
// one list page with live search, the Normal / Trusted / Blocked tabs,
// sorting, paging and CSV, so the two pages cannot drift apart (they
// were two hand copies of the same 150 lines).

/** The status tabs over the check customers and companies lists. */
const STATUS_TABS: Array<{ slug: string; label: MessageKey }> = [
  { slug: "",        label: "checkCashing.all" },
  { slug: "normal",  label: "checkCashing.statusNormal" },
  { slug: "trusted", label: "checkCashing.statusTrusted" },
  { slug: "blocked", label: "checkCashing.statusBlocked" },
];

type PartyPage<T> = CsvPage<T> & { rows: T[]; total: number; page: number };

export interface CheckPartyListProps<T> {
  title: string;
  /** "12 customers" for the answer's total. */
  subtitle: (total: number) => string;
  newTo: string;
  newLabel: string;
  searchPlaceholder: string;
  /** Rows per page is remembered per list under this key. */
  pageSizeKey: string;
  columns: DataColumn<T>[];
  useRows: (query: PartyListQuery) => UseQueryResult<PartyPage<T>>;
  fetchPage: (query: PartyListQuery) => Promise<PartyPage<T>>;
  rowKey: (row: T) => number;
  rowTo: (row: T) => string;
  rowLabel: (row: T) => string;
  emptyTitle: string;
  csvFilename: string;
}

export function CheckPartyList<T>({
  title, subtitle, newTo, newLabel, searchPlaceholder, pageSizeKey, columns,
  useRows, fetchPage, rowKey, rowTo, rowLabel, emptyTitle, csvFilename,
}: CheckPartyListProps<T>) {
  const t = useT();
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "", status: "" }, {
    pageSizeKey,
    defaultSort: { key: "name", direction: "asc" },
  });
  const listQuery: PartyListQuery = {
    q: filters.params.q, status: filters.params.status,
    sort: filters.sort?.key, dir: filters.sort?.direction,
  };
  const { data, isLoading, isError, error, refetch } = useRows({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });

  if (identity?.store_id == null) return <DeskNoStore title={title} />;

  return (
    <DeskPage>
      <PageCrumbs />
      <PageHeader
        title={title}
        subtitle={data ? subtitle(data.total) : "—"}
        actions={(
          <ButtonLink to={newTo} tone="primary" size="sm">{newLabel}</ButtonLink>
        )}
      />

      <Card className={styles.search}>
        <Field label={t("checkCashing.search")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={searchPlaceholder}
          />
        </Field>
      </Card>

      <TabsBar>
        {STATUS_TABS.map((s) => (
          <TabsButton
            key={s.slug}
            active={filters.params.status === s.slug}
            onClick={() => filters.setParam("status", s.slug)}
          >
            {t(s.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <DeskPane>
        <Card>
          <DataTable
            columns={columns}
            rows={data?.rows}
            rowKey={rowKey}
            onRowClick={(r) => navigate(rowTo(r))}
            rowLabel={rowLabel}
            isLoading={isLoading} isError={isError} error={error}
            onRetry={() => { void refetch(); }}
            emptyTitle={emptyTitle}
            sort={filters.sort}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: csvFilename,
              fetchPage: (page, perPage) => fetchPage({ ...listQuery, page, perPage }),
            }}
          />
        </Card>
      </DeskPane>
    </DeskPage>
  );
}

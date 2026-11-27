import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  categoryLabels,
  dailyBookSlugs,
  fetchBankTransactions,
  syncBankTransactions,
  useBankAccounts,
  useBankCategories,
  useBankTransactions,
  type BankAccountRow,
  type BankCategoryGroup,
  type BankTransactionFilters,
  type BankTransactionRow,
} from "../api/bankSync";
import { BankCategoryCell } from "../components/BankCategoryCell";
import { BankCategoryOptions } from "../components/BankCategoryOptions";
import { BankRuleFromRow } from "../components/BankRuleFromRow";
import {
  Button, ButtonLink,
  Card, Checkbox, DataTable, DateInput, Empty, Field, Input, KpiCard, KpiGrid,
  monoStyle, PageHeader, PageShell, Select, TabsBar, TabsButton, useToast,
  type DataColumn, type DataTableProps,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { hasPermission } from "../lib/permissions";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import {
  csvDate, formatDate, formatDateTime,
} from "../lib/datetime";
import { csvMoney } from "../lib/csv";
import styles from "./BankTransactions.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { BooksCell, BooksSummary, PossibleDoublesCard } from "./BankMatching";
import { booksStatusLabel, canDismissRow } from "../lib/bankMatching";
import { t as translate, tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Bank transactions at /app/bank-transactions. Three tabs split the
// list: To reconcile (the default — rows still needing a person, the
// same rule as the bell, `reconcile.to_reconcile_clauses`),
// Reconciled (the rest: tagged by a rule or by hand, matched, added
// to the daily book, dismissed) and All. A row changed in one tab
// moves to the other on the next load; clearing a category or
// unmatching brings it back. Filters: account, category, sign, dates,
// free-text search. Each row's category
// cell is editable inline — pick a category and the SPA POSTs
// /bank/transactions/{id}/categorize. A daily-book category books
// the row on that day's book (the day's total moves at once) and
// the cell links to it; a locked day comes back as a 409 the row
// turns into "book on another day" instead of failing silently.
// "Make a rule" opens the shared rule form prefilled from the row.
//
// Which day it books on is the operator's call. The bank's posting
// date is the default, not the truth — a check deposited Friday
// afternoon posts Monday morning, and belongs on Friday's close-out
// — so a booked row offers "Change day". The server remembers the
// choice on the row, so re-tagging does not walk it back.
//
// With the store's bank matching switched on (BankMatching.tsx), a
// "Daily book" column shows whether the money is already there
// (matched / added from bank), needs a person (check match), or is
// not on the books yet; admins can dismiss rows already handled.

/** The page's tabs, in order. The URL keeps "" for the default tab
 *  so a plain link (the bell's) opens To reconcile. */
const RECONCILE_TABS = [
  { slug: "", label: "bankTxn.tabToReconcile", count: "to_reconcile_count" },
  { slug: "reconciled", label: "bankTxn.tabReconciled", count: "reconciled_count" },
  { slug: "all", label: "bankTxn.tabAll", count: null },
] as const;

function tabFilter(slug: string): BankTransactionFilters["tab"] {
  if (slug === "all") return "";
  return slug === "reconciled" ? "reconciled" : "to_reconcile";
}

export default function BankTransactions() {
  const identity = getCurrentIdentity();
  const accounts = useBankAccounts();
  const categories = useBankCategories();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const t = useT();
  const [syncing, setSyncing] = useState(false);
  const [ruleFor, setRuleFor] = useState<BankTransactionRow | null>(null);

  // Filters, page, sort in the URL; search as you type (300ms, two
  // characters) like every list — CLAUDE.md "Table search UX".
  const url = useUrlFilterState({
    posted_from: "", posted_to: "", account_id: "", category_slug: "",
    sign: "", q: "", tab: "",
  }, {
    pageSizeKey: "bank-transactions",
    defaultSort: { key: "posted", direction: "desc" },
  });
  const { params, setParam } = url;

  const filters: BankTransactionFilters = {
    posted_from:        params.posted_from,
    posted_to:          params.posted_to,
    account_id:         params.account_id,
    category_slug:      params.category_slug,
    sign:               params.sign as "" | "credit" | "debit",
    q:                  params.q.length >= 2 ? params.q : "",
    tab:                tabFilter(params.tab),
    sort:               url.sort?.key,
    dir:                url.sort?.direction,
    page:               url.page,
    per_page:           url.perPage,
  };

  const txns = useBankTransactions(filters);
  const matching = Boolean(txns.data?.matching_enabled);
  const [ticked, setTicked] = useState<number[]>([]);

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title={navWord("Bank transactions")} />
        <Empty>{t("bankTxn.signInAdmin")}</Empty>
      </PageShell>
    );
  }

  const groups     = categories.data?.groups;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Bank transactions")}
        subtitle={
          txns.data
            ? t("bankTxn.subtitle", {
              total: fmtNumber(txns.data.total),
              uncategorized: fmtNumber(txns.data.uncategorized_count),
            })
            : "—"
        }
        actions={
          <div className={styles.headerActions}>
            <Button
              tone="primary" size="sm"
              busy={syncing}
              disabled={syncing}
              onClick={async () => {
                setSyncing(true);
                try {
                  const r = await syncBankTransactions();
                  toast({
                    message: tn("bankTxn.synced", r.new_rows, fmtNumber),
                    tone: "success",
                  });
                  void qc.invalidateQueries({ queryKey: ["bank"] });
                } catch (err) {
                  toastApiError(err, t("bankTxn.syncFailed"));
                } finally {
                  setSyncing(false);
                }
              }}
            >
              {syncing ? t("bankTxn.syncing") : t("bankTxn.sync")}
            </Button>
            <ButtonLink to="/bank/rules" tone="secondary" size="sm">
              {t("bankTxn.rules")}
            </ButtonLink>
            <ButtonLink to="/bank" tone="secondary" size="sm">
              {t("bankTxn.manageAccounts")}
            </ButtonLink>
          </div>
        }
      />

      {accounts.data && accounts.data.rows.length > 0 && (
        <BalanceCards accounts={accounts.data.rows} />
      )}

      {matching && <PossibleDoublesCard />}

      <Card>
        <div className="ds-filter-bar">
          <Field label={t("bankTxn.search")}>
            <Input
              type="search"
              value={url.draft.q ?? params.q}
              placeholder={t("bankTxn.searchPh")}
              onChange={(e) => url.debounced("q", e.target.value)}
            />
          </Field>
          <Field label={t("bankTxn.account")}>
            <Select
              value={filters.account_id ?? ""}
              onChange={(e) => setParam("account_id", e.target.value)}
            >
              <option value="">{t("bankTxn.allAccounts")}</option>
              {accounts.data?.rows.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("bankTxn.category")}>
            <Select
              value={filters.category_slug ?? ""}
              onChange={(e) => setParam("category_slug", e.target.value)}
            >
              <option value="">{t("bankTxn.anyCategory")}</option>
              <BankCategoryOptions groups={groups} />
            </Select>
          </Field>
          <Field label={t("bankTxn.sign")}>
            <Select
              value={filters.sign ?? ""}
              onChange={(e) => setParam("sign", e.target.value as "credit" | "debit" | "")}
            >
              <option value="">{t("bankTxn.any")}</option>
              <option value="credit">{t("bankTxn.credit")}</option>
              <option value="debit">{t("bankTxn.debit")}</option>
            </Select>
          </Field>
          <Field label={t("bankTxn.from")}>
            <DateInput
              value={filters.posted_from ?? ""}
              onChange={(e) => setParam("posted_from", e.target.value)}
            />
          </Field>
          <Field label={t("bankTxn.to")}>
            <DateInput
              value={filters.posted_to ?? ""}
              onChange={(e) => setParam("posted_to", e.target.value)}
            />
          </Field>
        </div>

        <TabsBar>
          {RECONCILE_TABS.map((tab) => (
            <TabsButton
              key={tab.slug}
              active={params.tab === tab.slug}
              onClick={() => { setTicked([]); setParam("tab", tab.slug); }}
            >
              {tab.count
                ? t(tab.label, {
                  count: txns.data ? fmtNumber(txns.data[tab.count] ?? 0) : "—",
                })
                : t(tab.label)}
            </TabsButton>
          ))}
        </TabsBar>

        {matching && (
          <BooksSummary
            counts={txns.data?.books_counts}
            ticked={ticked}
            onClearTicked={() => setTicked([])}
          />
        )}

        <TxnTable
          rows={txns.data?.rows}
          groups={groups}
          matching={matching}
          ticked={ticked}
          onTick={(id, on) =>
            setTicked((t) => (on ? [...t, id] : t.filter((x) => x !== id)))}
          onMakeRule={setRuleFor}
          isLoading={txns.isLoading} isError={txns.isError} error={txns.error}
          onRetry={() => { void txns.refetch(); }}
          sort={url.sort}
          page={txns.data && {
            page: txns.data.page,
            totalPages: txns.data.total_pages,
            total: txns.data.total,
            onPage: url.setPage,
            perPage: url.perPage,
            onPerPage: url.setPerPage,
            leading: (
              <span className={styles.pagerLead}>
                {t("bankTxn.pageTotal")}{" "}
                <span style={monoStyle}>
                  {fmtMoney2(txns.data.page_total_cents / 100)}
                </span>
              </span>
            ),
          }}
          exportCsv={{
            filename: "bank-transactions",
            fetchPage: (page, perPage) => fetchBankTransactions({
              ...filters, page, per_page: perPage,
            }),
          }}
        />
      </Card>

      <BankRuleFromRow row={ruleFor} onClose={() => setRuleFor(null)} />
    </PageShell>
  );
}

function TxnTable({
  rows, groups, matching, ticked, onTick, onMakeRule, ...table
}: {
  rows: BankTransactionRow[] | undefined;
  groups: BankCategoryGroup[] | undefined;
  /** The store has bank matching on: show the Daily book column. */
  matching: boolean;
  ticked: number[];
  onTick: (id: number, on: boolean) => void;
  onMakeRule: (row: BankTransactionRow) => void;
} & Pick<
  DataTableProps<BankTransactionRow>,
  "isLoading" | "isError" | "error" | "onRetry" | "sort" | "page" | "exportCsv"
>) {
  const qc = useQueryClient();
  const identity = getCurrentIdentity();
  const t = useT();
  const labels = useMemo(() => categoryLabels(groups), [groups]);
  const bookable = useMemo(() => dailyBookSlugs(groups), [groups]);
  const columns = useMemo<DataColumn<BankTransactionRow>[]>(() => {
    function refresh() {
      void qc.invalidateQueries({
        queryKey: ["bank", "transactions", identity?.store_id],
      });
    }
    const canDismiss = matching && hasPermission("bank_dismiss", "update");
    const tickColumn: DataColumn<BankTransactionRow>[] = canDismiss ? [{
      key: "tick", header: t("bankTxn.select"),
      render: (r) => canDismissRow(r) ? (
        <Checkbox
          aria-label={t("bankTxn.tickAria", { desc: r.description || t("bankTxn.transaction") })}
          checked={ticked.includes(r.id)}
          onChange={(v) => onTick(r.id, v)}
        />
      ) : null,
    }] : [];
    const booksColumn: DataColumn<BankTransactionRow>[] = matching ? [{
      key: "books", header: t("bankTxn.dailyBook"),
      render: (r) => <BooksCell row={r} />,
      csv: (r) => booksStatusLabel(r.books_status),
    }] : [];
    return [
      ...tickColumn,
      {
        key: "posted", header: t("bankTxn.posted"), sortKey: "posted", sortFirst: "desc",
        render: (r) => <span className={styles.dateCell}>{formatDate(r.posted_at)}</span>,
        csv: (r) => csvDate(r.posted_at),
      },
      {
        key: "description", header: t("bankTxn.description"), sortKey: "description",
        render: (r) => r.description || "—",
        csv: (r) => r.description,
      },
      {
        key: "account", header: t("bankTxn.account"),
        render: (r) => (
          <span className={styles.accountCell}>
            {r.account_label || t("bankTxn.accountN", { id: r.account_id })}
          </span>
        ),
        csv: (r) => r.account_label || t("bankTxn.accountN", { id: r.account_id }),
      },
      {
        key: "category", header: t("bankTxn.category"), sortKey: "category",
        render: (r) => (
          <BankCategoryCell
            row={r}
            groups={groups}
            labels={labels}
            bookable={bookable}
            onChanged={refresh}
            onMakeRule={() => onMakeRule(r)}
          />
        ),
        csv: (r) => (r.category_slug ? labels.get(r.category_slug) ?? r.category_slug : ""),
      },
      ...booksColumn,
      {
        key: "amount", header: t("bankTxn.amount"), align: "right", sortKey: "amount", sortFirst: "desc",
        render: (r) => (
          <span className={r.amount_cents > 0 ? styles.amountPos : styles.amountNeutral}>
            {r.amount_cents > 0 ? "+" : ""}{fmtMoney2(r.amount)}
          </span>
        ),
        csv: (r) => csvMoney(r.amount),
      },
    ];
  }, [
    qc, identity?.store_id, groups, labels, bookable, onMakeRule,
    matching, ticked, onTick, t,
  ]);
  return (
    <DataTable
      {...table}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      emptyTitle={t("bankTxn.empty")}
    />
  );
}

function BalanceCards({ accounts }: { accounts: BankAccountRow[] }) {
  const active = accounts.filter((a) => a.enabled && !a.disconnected_at);
  if (active.length === 0) return null;
  return (
    <KpiGrid minWidth="200px">
      {active.map((a) => (
        <KpiCard
          key={a.id}
          label={a.nickname || a.display_name || a.institution_name}
          value={fmtMoney2(a.last_balance)}
          sub={
            a.last_balance_as_of
              ? translate("bank.asOf", { date: formatDateTime(a.last_balance_as_of) })
              : translate("bank.notRefreshed")
          }
        />
      ))}
    </KpiGrid>
  );
}


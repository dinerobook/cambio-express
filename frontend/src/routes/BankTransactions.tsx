import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  categorizeTransaction,
  categoryLabels,
  dailyBookSlugs,
  fetchBankTransactions,
  lockedDayFromError,
  syncBankTransactions,
  uncategorizeTransaction,
  useBankAccounts,
  useBankCategories,
  useBankTransactions,
  type BankAccountRow,
  type BankCategoryGroup,
  type BankTransactionFilters,
  type BankTransactionRow,
} from "../api/bankSync";
import { BankCategoryOptions } from "../components/BankCategoryOptions";
import { BankRuleForm } from "../components/BankRuleForm";
import {
  AppLink, Button, ButtonLink,
  Card, Checkbox, DataTable, DateInput, Empty, Field, Input, KpiCard, KpiGrid,
  Modal, monoStyle, PageHeader, PageShell, Select, TabsBar, TabsButton, useToast,
  type DataColumn, type DataTableProps,
} from "../components/ui";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { apiErrorMessage } from "../lib/api";
import { describeAppliedRule } from "../lib/bankRules";
import { suggestRuleFor } from "../lib/bankRuleSuggest";
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
import { t as translate, tn, tNodes, useT } from "../i18n";
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

      <Modal
        open={ruleFor != null}
        onClose={() => setRuleFor(null)}
        title={t("bankTxn.ruleTitle")}
        size="lg"
      >
        {ruleFor && (
          <>
            <p className={styles.modalLead}>
              {tNodes("bankTxn.ruleLead", {
                desc: <strong>{ruleFor.description || t("bankTxn.this")}</strong>,
              })}
            </p>
            <BankRuleForm
              key={ruleFor.id}
              initial={{
                ...suggestRuleFor(ruleFor),
                target_kind: ruleFor.category_slug,
                account_filter_id: "",
              }}
              onCancel={() => setRuleFor(null)}
              onSaved={(resp) => {
                setRuleFor(null);
                toast({
                  message: `${t("bankTxn.ruleCreated")}${describeAppliedRule(resp.applied)}`,
                  tone: "success",
                });
                void qc.invalidateQueries({ queryKey: ["bank"] });
              }}
            />
          </>
        )}
      </Modal>
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
          <CategoryCell
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

function CategoryCell({
  row, groups, labels, bookable, onChanged, onMakeRule,
}: {
  row: BankTransactionRow;
  groups: BankCategoryGroup[] | undefined;
  labels: Map<string, string>;
  bookable: Set<string>;
  onChanged: () => void;
  onMakeRule: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A locked day: the slug the operator picked + the date the
  // server refused, so the cell can offer another day.
  const [locked, setLocked] = useState<{ slug: string; date: string } | null>(null);
  // The line this row already booked sits on a locked day: untagging
  // or re-tagging would change that day, so the only way on is to
  // unlock it — no other day to offer.
  const [lockedLine, setLockedLine] = useState<string | null>(null);
  // Open when the operator is choosing the day this row books on.
  const [choosingDay, setChoosingDay] = useState(false);

  // `day` mirrors the endpoint's tri-state: undefined keeps the day
  // the row already carries, a date sets it, null clears it back to
  // the bank's posting date.
  async function pick(slug: string, day?: string | null) {
    setErr(null); setBusy(true);
    try {
      if (slug === "") {
        await uncategorizeTransaction(row.id);
      } else {
        const resp = await categorizeTransaction(row.id, {
          target_kind: slug,
          post_to_daily: true,
          ...(day !== undefined ? { report_date: day } : {}),
        });
        const txn = resp.transaction;
        if (txn.booked_on) {
          toast({
            message: t("bankTxn.bookedToast", { date: formatDate(txn.booked_on) }),
            tone: "success",
          });
        }
      }
      setLocked(null);
      setLockedLine(null);
      setChoosingDay(false);
      onChanged();
    } catch (e) {
      const lockedDay = lockedDayFromError(e);
      if (lockedDay && lockedDay.report_date === row.booked_on) {
        setLockedLine(lockedDay.report_date);
        setLocked(null);
        setChoosingDay(false);
      } else if (lockedDay) {
        setLocked({ slug, date: lockedDay.report_date });
        setChoosingDay(false);
      } else {
        setErr(apiErrorMessage(e, t("bankTxn.updateFailed")));
      }
    } finally {
      setBusy(false);
    }
  }

  const booksALine = Boolean(row.category_slug) && bookable.has(row.category_slug);

  const label = labels.get(row.category_slug) ?? row.category_slug;

  // Read-only for anyone who cannot categorise: the label instead
  // of a dropdown that would 403 on change.
  if (!hasPermission("bank_sync", "update")) {
    return (
      <div className={styles.categoryCell}>
        <span className={row.category_slug ? styles.categorySelectMono : undefined}>
          {row.category_slug ? label : t("bankTxn.uncategorized")}
        </span>
        <BookedLink row={row} />
      </div>
    );
  }

  return (
    <div className={styles.categoryCell}>
      <Select
        value={row.category_slug}
        onChange={(e) => pick(e.target.value)}
        disabled={busy}
        aria-label={t("bankTxn.category")}
        className={
          row.category_slug
            ? `${styles.categorySelect} ${styles.categorySelectMono}`
            : styles.categorySelect
        }
      >
        <option value="">{t("bankTxn.uncategorized")}</option>
        <BankCategoryOptions groups={groups} />
        {row.category_slug && !labels.has(row.category_slug) && (
          <option value={row.category_slug}>{row.category_slug}</option>
        )}
      </Select>
      <BookedLink row={row} />
      {booksALine && !row.booked_on && !locked && (
        <span
          className={styles.notBooked}
          title={
            row.report_date_override
              ? t("bankTxn.taggedFor", { date: formatDate(row.report_date_override) })
              : t("bankTxn.taggedNoLine")
          }
        >
          {t("bankTxn.notBooked")}
          {row.report_date_override && ` · ${formatDate(row.report_date_override)}`}
        </span>
      )}
      {booksALine && !locked && !choosingDay && (
        <Button
          tone="ghost" size="sm"
          disabled={busy}
          onClick={() => setChoosingDay(true)}
          title={t("bankTxn.changeDayTip")}
        >
          {row.booked_on ? t("bankTxn.changeDay") : t("bankTxn.pickDay")}
        </Button>
      )}
      <Button
        tone="ghost" size="sm" perm="bank_sync.create"
        onClick={onMakeRule}
        title={t("bankTxn.makeRuleTip")}
      >
        {t("bankTxn.makeRule")}
      </Button>
      {err && (
        <span title={err} className={styles.errorMark} role="alert">
          ⚠ {err}
        </span>
      )}
      {choosingDay && (
        <BookDayForm
          initial={row.booked_on || row.report_date_override || row.bank_date}
          busy={busy}
          lead={
            <>
              {t("bankTxn.bookOnLead")}{" "}
              {row.bank_date
                ? t("bankTxn.bankPosted", { date: formatDate(row.bank_date) })
                : ""}
            </>
          }
          onConfirm={(d) => { void pick(row.category_slug, d); }}
          onUseBankDate={
            row.report_date_override
              ? () => { void pick(row.category_slug, null); }
              : undefined
          }
          onCancel={() => setChoosingDay(false)}
        />
      )}
      {lockedLine && (
        <div className={styles.lockedRow} role="alert">
          <span>
            {tNodes("bankTxn.lockedLine", {
              date: formatDate(lockedLine),
              link: <AppLink to={`/daily/edit?date=${lockedLine}`}>{t("bankTxn.openIt")}</AppLink>,
            })}
          </span>
          <Button size="sm" tone="secondary" onClick={() => setLockedLine(null)}>
            {t("bankTxn.ok")}
          </Button>
        </div>
      )}
      {locked && (
        <BookDayForm
          alert
          initial=""
          busy={busy}
          lead={
            <>
              {tNodes("bankTxn.lockedDay", {
                date: formatDate(locked.date),
                link: <AppLink to={`/daily/edit?date=${locked.date}`}>{t("bankTxn.openIt")}</AppLink>,
              })}
            </>
          }
          onConfirm={(d) => { void pick(locked.slug, d); }}
          onCancel={() => setLocked(null)}
        />
      )}
    </div>
  );
}

/** Pick the day a transaction books on. Two callers — the operator
 *  changing the day on purpose, and the locked-day recovery after a
 *  409 — so it lives here rather than twice inside the cell. The
 *  date lives in this component's state and resets when it
 *  unmounts, which is what closing the form should do. */
function BookDayForm({
  lead, initial, busy, alert = false, onConfirm, onCancel, onUseBankDate,
}: {
  lead: ReactNode;
  /** Day the input starts on; "" leaves it empty. */
  initial: string;
  busy: boolean;
  /** Render as a warning callout (the locked-day case). */
  alert?: boolean;
  onConfirm: (day: string) => void;
  onCancel: () => void;
  /** Offered only when the row carries a day of its own to drop. */
  onUseBankDate?: () => void;
}) {
  const [day, setDay] = useState(initial);
  const t = useT();
  return (
    <div className={styles.lockedRow} role={alert ? "alert" : "group"}>
      <span>{lead}</span>
      <DateInput
        value={day}
        onChange={(e) => setDay(e.target.value)}
        aria-label={t("bankTxn.bookOnDate")}
      />
      <Button
        size="sm" disabled={!day || busy} busy={busy}
        onClick={() => onConfirm(day)}
      >
        {t("bankTxn.book")}
      </Button>
      {onUseBankDate && (
        <Button size="sm" tone="ghost" disabled={busy} onClick={onUseBankDate}>
          {t("bankTxn.useBankDate")}
        </Button>
      )}
      <Button size="sm" tone="secondary" disabled={busy} onClick={onCancel}>
        {t("bankTxn.cancel")}
      </Button>
    </div>
  );
}


function BookedLink({ row }: { row: BankTransactionRow }) {
  const t = useT();
  if (!row.booked_on) return null;
  return (
    <AppLink
      to={`/daily/edit?date=${row.booked_on}`}
      className={styles.bookedLink}
      title={t("bankTxn.openDayTip")}
    >
      {t("bankTxn.booked", { date: formatDate(row.booked_on) })}
    </AppLink>
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


import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  categorizeTransaction,
  categoryLabels,
  dailyBookSlugs,
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
  Modal, monoStyle, PageHeader, PageShell, Select, useToast,
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
  formatDate, formatDateTime,
} from "../lib/datetime";
import styles from "./BankTransactions.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// Bank transactions at /app/bank-transactions. Filters: account,
// sign, uncategorized-only, free-text search. Each row's category
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

export default function BankTransactions() {
  const identity = getCurrentIdentity();
  const accounts = useBankAccounts();
  const categories = useBankCategories();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [syncing, setSyncing] = useState(false);
  const [ruleFor, setRuleFor] = useState<BankTransactionRow | null>(null);

  // Filters, page, sort in the URL; search as you type (300ms, two
  // characters) like every list — CLAUDE.md "Table search UX".
  const url = useUrlFilterState({
    posted_from: "", posted_to: "", account_id: "", category_slug: "",
    sign: "", q: "", uncategorized_only: "",
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
    uncategorized_only: params.uncategorized_only === "1",
    sort:               url.sort?.key,
    dir:                url.sort?.direction,
    page:               url.page,
    per_page:           url.perPage,
  };

  const txns = useBankTransactions(filters);

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title="Bank transactions" />
        <Empty>Sign in as a store admin to view bank transactions.</Empty>
      </PageShell>
    );
  }

  const groups     = categories.data?.groups;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Bank transactions"
        subtitle={
          txns.data
            ? `${fmtNumber(txns.data.total)} transactions · ` +
              `${fmtNumber(txns.data.uncategorized_count)} uncategorized`
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
                    message: `Synced ${r.new_rows} new transaction${r.new_rows === 1 ? "" : "s"}.`,
                    tone: "success",
                  });
                  void qc.invalidateQueries({ queryKey: ["bank"] });
                } catch (err) {
                  toastApiError(err, "Sync failed.");
                } finally {
                  setSyncing(false);
                }
              }}
            >
              {syncing ? "Syncing…" : "Sync transactions"}
            </Button>
            <ButtonLink to="/bank/rules" tone="secondary" size="sm">
              Rules
            </ButtonLink>
            <ButtonLink to="/bank" tone="secondary" size="sm">
              Manage accounts
            </ButtonLink>
          </div>
        }
      />

      {accounts.data && accounts.data.rows.length > 0 && (
        <BalanceCards accounts={accounts.data.rows} />
      )}

      <Card>
        <div className="ds-filter-bar">
          <Field label="Search">
            <Input
              type="search"
              value={url.draft.q ?? params.q}
              placeholder="Description…"
              onChange={(e) => url.debounced("q", e.target.value)}
            />
          </Field>
          <Field label="Account">
            <Select
              value={filters.account_id ?? ""}
              onChange={(e) => setParam("account_id", e.target.value)}
            >
              <option value="">All accounts</option>
              {accounts.data?.rows.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Category">
            <Select
              value={filters.category_slug ?? ""}
              onChange={(e) => setParam("category_slug", e.target.value)}
            >
              <option value="">Any category</option>
              <BankCategoryOptions groups={groups} />
            </Select>
          </Field>
          <Field label="Sign">
            <Select
              value={filters.sign ?? ""}
              onChange={(e) => setParam("sign", e.target.value as "credit" | "debit" | "")}
            >
              <option value="">Any</option>
              <option value="credit">Credit</option>
              <option value="debit">Debit</option>
            </Select>
          </Field>
          <Field label="From">
            <DateInput
              value={filters.posted_from ?? ""}
              onChange={(e) => setParam("posted_from", e.target.value)}
            />
          </Field>
          <Field label="To">
            <DateInput
              value={filters.posted_to ?? ""}
              onChange={(e) => setParam("posted_to", e.target.value)}
            />
          </Field>
          <Field label="Filter">
            <Checkbox
              checked={filters.uncategorized_only}
              onChange={(v) =>
                setParam("uncategorized_only", v ? "1" : "")
              }
            >
              Uncategorized only
            </Checkbox>
          </Field>
        </div>

        <TxnTable
          rows={txns.data?.rows}
          groups={groups}
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
                Page total:{" "}
                <span style={monoStyle}>
                  {fmtMoney2(txns.data.page_total_cents / 100)}
                </span>
              </span>
            ),
          }}
        />
      </Card>

      <Modal
        open={ruleFor != null}
        onClose={() => setRuleFor(null)}
        title="Make a rule from this transaction"
        size="lg"
      >
        {ruleFor && (
          <>
            <p className={styles.modalLead}>
              Next time a transaction like <strong>{ruleFor.description || "this"}</strong>{" "}
              comes in, it will be categorized for you. Adjust the match so it
              is specific enough, then save.
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
                  message: `Rule created.${describeAppliedRule(resp.applied)}`,
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
  rows, groups, onMakeRule, ...table
}: {
  rows: BankTransactionRow[] | undefined;
  groups: BankCategoryGroup[] | undefined;
  onMakeRule: (row: BankTransactionRow) => void;
} & Pick<
  DataTableProps<BankTransactionRow>,
  "isLoading" | "isError" | "error" | "onRetry" | "sort" | "page"
>) {
  const qc = useQueryClient();
  const identity = getCurrentIdentity();
  const labels = useMemo(() => categoryLabels(groups), [groups]);
  const bookable = useMemo(() => dailyBookSlugs(groups), [groups]);
  const columns = useMemo<DataColumn<BankTransactionRow>[]>(() => {
    function refresh() {
      void qc.invalidateQueries({
        queryKey: ["bank", "transactions", identity?.store_id],
      });
    }
    return [
      {
        key: "posted", header: "Posted", sortKey: "posted", sortFirst: "desc",
        render: (r) => <span className={styles.dateCell}>{formatDate(r.posted_at)}</span>,
      },
      {
        key: "description", header: "Description", sortKey: "description",
        render: (r) => r.description || "—",
      },
      {
        key: "account", header: "Account",
        render: (r) => (
          <span className={styles.accountCell}>
            {r.account_label || `Account ${r.account_id}`}
          </span>
        ),
      },
      {
        key: "category", header: "Category", sortKey: "category",
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
      },
      {
        key: "amount", header: "Amount", align: "right", sortKey: "amount", sortFirst: "desc",
        render: (r) => (
          <span className={r.amount_cents > 0 ? styles.amountPos : styles.amountNeutral}>
            {r.amount_cents > 0 ? "+" : ""}{fmtMoney2(r.amount)}
          </span>
        ),
      },
    ];
  }, [qc, identity?.store_id, groups, labels, bookable, onMakeRule]);
  return (
    <DataTable
      {...table}
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      emptyTitle="No transactions match these filters."
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
        const t = resp.transaction;
        if (t.booked_on) {
          toast({
            message: `Booked on the daily book for ${formatDate(t.booked_on)}.`,
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
        setErr(apiErrorMessage(e, "Could not update category."));
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
          {row.category_slug ? label : "— uncategorized —"}
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
        aria-label="Category"
        className={
          row.category_slug
            ? `${styles.categorySelect} ${styles.categorySelectMono}`
            : styles.categorySelect
        }
      >
        <option value="">— uncategorized —</option>
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
              ? `Tagged for ${formatDate(row.report_date_override)}, but no line on that day's book.`
              : "Tagged, but no line on the daily book."
          }
        >
          not booked
          {row.report_date_override && ` · ${formatDate(row.report_date_override)}`}
        </span>
      )}
      {booksALine && !locked && !choosingDay && (
        <Button
          tone="ghost" size="sm"
          disabled={busy}
          onClick={() => setChoosingDay(true)}
          title="Book this on a different day — the bank's posting date is not always the day the money moved"
        >
          {row.booked_on ? "Change day" : "Pick a day"}
        </Button>
      )}
      <Button
        tone="ghost" size="sm" perm="bank_sync.create"
        onClick={onMakeRule}
        title="Create a rule that categorizes transactions like this one automatically"
      >
        Make a rule
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
              Book this on the daily book for{" "}
              {row.bank_date
                ? `(the bank posted it ${formatDate(row.bank_date)})`
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
            The daily book for {formatDate(lockedLine)} is locked, so the
            line this transaction booked there can&rsquo;t change.{" "}
            <AppLink to={`/daily/edit?date=${lockedLine}`}>Open it</AppLink>{" "}
            to unlock it first.
          </span>
          <Button size="sm" tone="secondary" onClick={() => setLockedLine(null)}>
            OK
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
              The daily book for {formatDate(locked.date)} is locked.{" "}
              <AppLink to={`/daily/edit?date=${locked.date}`}>Open it</AppLink> to
              unlock, or book on another day:
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
  return (
    <div className={styles.lockedRow} role={alert ? "alert" : "group"}>
      <span>{lead}</span>
      <DateInput
        value={day}
        onChange={(e) => setDay(e.target.value)}
        aria-label="Book on date"
      />
      <Button
        size="sm" disabled={!day || busy} busy={busy}
        onClick={() => onConfirm(day)}
      >
        Book
      </Button>
      {onUseBankDate && (
        <Button size="sm" tone="ghost" disabled={busy} onClick={onUseBankDate}>
          Use the bank&rsquo;s date
        </Button>
      )}
      <Button size="sm" tone="secondary" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}


function BookedLink({ row }: { row: BankTransactionRow }) {
  if (!row.booked_on) return null;
  return (
    <AppLink
      to={`/daily/edit?date=${row.booked_on}`}
      className={styles.bookedLink}
      title="Open that day's daily book"
    >
      booked {formatDate(row.booked_on)}
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
              ? `As of ${formatDateTime(a.last_balance_as_of)}`
              : "Balance not yet refreshed."
          }
        />
      ))}
    </KpiGrid>
  );
}


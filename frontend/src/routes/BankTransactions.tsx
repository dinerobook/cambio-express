import { useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

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
import { BankRuleForm } from "../components/BankRuleForm";
import {
  Alert, AppLink, Breadcrumbs, Button, ButtonLink,
  Card, Checkbox, DateInput, Empty, Field, Input, KpiCard, KpiGrid,
  Modal, monoStyle, PageHeader, PageShell, Pager, Select, Table, TableStates,
  tdStyle, thStyle, useToast,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { suggestRuleFor } from "../lib/bankRuleSuggest";
import { hasPermission } from "../lib/permissions";
import { getCurrentIdentity } from "../lib/auth";
import { fmtMoney2 } from "../lib/formatters";
import { formatDate } from "../lib/datetime";
import styles from "./BankTransactions.module.css";

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

const PER_PAGE = 50;

export default function BankTransactions() {
  const identity = getCurrentIdentity();
  const accounts = useBankAccounts();
  const categories = useBankCategories();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSP] = useSearchParams();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [ruleFor, setRuleFor] = useState<BankTransactionRow | null>(null);

  const filters: BankTransactionFilters = useMemo(() => ({
    posted_from:        sp.get("posted_from") ?? "",
    posted_to:          sp.get("posted_to")   ?? "",
    account_id:         sp.get("account_id")  ?? "",
    category_slug:      sp.get("category_slug") ?? "",
    sign:               (sp.get("sign") as "" | "credit" | "debit") ?? "",
    q:                  sp.get("q")           ?? "",
    uncategorized_only: sp.get("uncategorized_only") === "1",
    page:               Number(sp.get("page") ?? 1),
    per_page:           PER_PAGE,
  }), [sp]);

  const txns = useBankTransactions(filters);
  const [qDraft, setQDraft] = useState(filters.q ?? "");

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else       next.delete(key);
    next.delete("page");
    setSP(next, { replace: true });
  }

  function setPage(page: number) {
    const next = new URLSearchParams(sp);
    if (page > 1) next.set("page", String(page));
    else          next.delete("page");
    setSP(next, { replace: true });
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title="Bank transactions" />
        <Empty>Sign in as a store admin to view bank transactions.</Empty>
      </PageShell>
    );
  }

  const totalPages = txns.data?.total_pages ?? 1;
  const page       = txns.data?.page        ?? 1;
  const groups     = categories.data?.groups;

  return (
    <PageShell>

      <Breadcrumbs crumbs={[{ label: "Finance" }, { label: "Bank transactions" }]} />

      <PageHeader
        title="Bank transactions"
        subtitle={
          txns.data
            ? `${txns.data.total.toLocaleString()} transactions · ` +
              `${txns.data.uncategorized_count.toLocaleString()} uncategorized`
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
                setSyncMsg(null);
                try {
                  const r = await syncBankTransactions();
                  setSyncMsg(`Synced ${r.new_rows} new transaction${r.new_rows === 1 ? "" : "s"}.`);
                  void qc.invalidateQueries({ queryKey: ["bank"] });
                } catch (err) {
                  setSyncMsg(
                    err instanceof ApiError ? err.message : "Sync failed.",
                  );
                } finally {
                  setSyncing(false);
                  setTimeout(() => setSyncMsg(null), 5000);
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

      {syncMsg && <Alert tone="success">{syncMsg}</Alert>}

      {accounts.data && accounts.data.rows.length > 0 && (
        <BalanceCards accounts={accounts.data.rows} />
      )}

      <Card>
        <div className="ds-filter-bar">
          <Field label="Search">
            <Input
              type="search"
              value={qDraft}
              placeholder="Description…"
              onChange={(e) => setQDraft(e.target.value)}
              onBlur={() => setParam("q", qDraft.trim())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setParam("q", qDraft.trim());
                }
              }}
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
              <CategoryOptions groups={groups} />
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

        <TableStates
          isLoading={txns.isLoading} isError={txns.isError} error={txns.error}
          isEmpty={!txns.data || txns.data.rows.length === 0}
          onRetry={() => { void txns.refetch(); }}
          emptyTitle="No transactions match these filters."
        />
        {txns.data && txns.data.rows.length > 0 && (
          <>
            <TxnTable
              rows={txns.data.rows}
              groups={groups}
              onMakeRule={setRuleFor}
            />
            <Pager
              page={page}
              totalPages={totalPages}
              onPage={setPage}
              leading={
                <span className={styles.pagerLead}>
                  Page total:{" "}
                  <span style={monoStyle}>
                    {fmtMoney2(txns.data.page_total_cents / 100)}
                  </span>
                </span>
              }
            />
          </>
        )}
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
                const a = resp.applied;
                const extra = a
                  ? ` ${a.tagged} existing transaction${a.tagged === 1 ? "" : "s"} tagged`
                    + (a.booked ? `, ${a.booked} booked` : "")
                    + (a.locked_skipped ? `, ${a.locked_skipped} skipped (day locked)` : "")
                    + "."
                  : "";
                toast({ message: `Rule created.${extra}`, tone: "success" });
                void qc.invalidateQueries({ queryKey: ["bank"] });
              }}
            />
          </>
        )}
      </Modal>
    </PageShell>
  );
}

function CategoryOptions({ groups }: { groups: BankCategoryGroup[] | undefined }) {
  return (
    <>
      {(groups ?? []).map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => (
            <option key={o.slug} value={o.slug}>{o.label}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

function TxnTable({
  rows, groups, onMakeRule,
}: {
  rows: BankTransactionRow[];
  groups: BankCategoryGroup[] | undefined;
  onMakeRule: (row: BankTransactionRow) => void;
}) {
  const qc = useQueryClient();
  const identity = getCurrentIdentity();
  const labels = useMemo(() => categoryLabels(groups), [groups]);
  const bookable = useMemo(() => dailyBookSlugs(groups), [groups]);
  function refresh() {
    qc.invalidateQueries({
      queryKey: ["bank", "transactions", identity?.store_id],
    });
  }
  return (
    <Table>
      <thead>
        <tr>
          {[
            ["Posted",      "left"],
            ["Description", "left"],
            ["Account",     "left"],
            ["Category",    "left"],
            ["Amount",      "right"],
          ].map(([label, align], i) => (
            <th key={i} style={{ ...thStyle, textAlign: align as "left" | "right" }}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td style={tdStyle}>
              <span className={styles.dateCell}>
                {formatDate(r.posted_at)}
              </span>
            </td>
            <td style={tdStyle}>{r.description || "—"}</td>
            <td style={tdStyle}>
              <span className={styles.accountCell}>
                {r.account_label || `Account ${r.account_id}`}
              </span>
            </td>
            <td style={tdStyle}>
              <CategoryCell
                row={r}
                groups={groups}
                labels={labels}
                bookable={bookable}
                onChanged={refresh}
                onMakeRule={() => onMakeRule(r)}
              />
            </td>
            <td style={{ ...tdStyle, textAlign: "right" }}>
              <span className={r.amount_cents > 0 ? styles.amountPos : styles.amountNeutral}>
                {r.amount_cents > 0 ? "+" : ""}{fmtMoney2(r.amount)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
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
      setChoosingDay(false);
      onChanged();
    } catch (e) {
      const lockedDay = lockedDayFromError(e);
      if (lockedDay) {
        setLocked({ slug, date: lockedDay.report_date });
        setChoosingDay(false);
      } else {
        setErr(e instanceof ApiError ? e.message : "Could not update category.");
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
        <CategoryOptions groups={groups} />
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
              ? `As of ${formatBalanceDate(a.last_balance_as_of)}`
              : "Balance not yet refreshed."
          }
        />
      ))}
    </KpiGrid>
  );
}


function formatBalanceDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

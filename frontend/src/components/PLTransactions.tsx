import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  categoryLabels, dailyBookSlugs, useBankCategories,
} from "../api/bankSync";
import {
  acceptPLSuggestions, fetchPLTransactions, MONTHLY_LINES, monthlyLineName,
  setEntryCategory, usePLTransactions, type PLAcceptResponse, type PLEntryTarget,
  type PLTransactionFilters, type PLTransactionRow, type PLTransactionView,
} from "../api/monthly";
import { BankCategoryCell } from "./BankCategoryCell";
import { BankRuleFromRow, type RuleSourceRow } from "./BankRuleFromRow";
import {
  Button, DataTable, Input, Pill, Select, TabsBar, TabsButton, useToast,
  type DataColumn, type PillTone,
} from "./ui";
import { apiErrorMessage } from "../lib/api";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import { hasPermission } from "../lib/permissions";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { csvDate, formatDate } from "../lib/datetime";
import { csvMoney } from "../lib/csv";
import { t, tn, useT, type MessageKey } from "../i18n";
import styles from "./PLTransactions.module.css";

// The Monthly P&L's Transactions tab (Monthly INVARIANTS
// "Transactions"): every dollar of the month, one row each — bank
// rows, daily book entries and day figures, the return-check line,
// typed lines. Counted rows add up to the statement. A bank row is
// categorized in place with the same cell as the Bank page, and
// "Do this every time" makes a rule from it. Filters live in the URL
// (view, line, source, search) like every list, so a statement line
// links straight to its rows (`?tab=transactions&line=…`).

const VIEWS: ReadonlyArray<{ view: PLTransactionView; label: MessageKey }> = [
  { view: "review", label: "plTx.viewReview" },
  { view: "in_pl", label: "plTx.viewInPl" },
  { view: "not_pl", label: "plTx.viewNotPl" },
  { view: "all", label: "plTx.viewAll" },
];

const STATUS: Record<PLTransactionRow["status"], { label: MessageKey; tone: PillTone }> = {
  rule: { label: "plTx.status.rule", tone: "accent" },
  person: { label: "plTx.status.person", tone: "accent" },
  added: { label: "plTx.status.added", tone: "info" },
  matched: { label: "plTx.status.matched", tone: "info" },
  to_review: { label: "plTx.status.to_review", tone: "warning" },
  not_in_pl: { label: "plTx.status.not_in_pl", tone: "neutral" },
  daily: { label: "plTx.status.daily", tone: "info" },
  returned_checks: { label: "plTx.status.returned_checks", tone: "info" },
  typed: { label: "plTx.status.typed", tone: "neutral" },
  bank_wins: { label: "plTx.status.bank_wins", tone: "neutral" },
  typed_wins: { label: "plTx.status.typed_wins", tone: "neutral" },
};

/** Bank rows a person can still recategorize here: tagged or not,
 *  but not already standing for a daily book entry. */
const RECATEGORIZABLE = new Set(["to_review", "rule", "person", "not_in_pl"]);

/** The line a daily entry of a kind counts on when nobody moved it
 *  (the server's `entry_categories.movable_kinds`). */
const ENTRY_KIND_LINES: Record<string, string> = {
  cash_purchase: "cash_purchases",
  check_purchase: "check_purchases",
  cash_expense: "cash_expenses",
  check_expense: "check_expenses",
};

/** Where a row comes from, in words. */
function plSourceText(r: PLTransactionRow): string {
  switch (r.source) {
    case "bank":
      return r.description || t("plTx.src.bank");
    case "entry":
      return r.description
        ? t("plTx.src.entryNote", { note: r.description })
        : t("plTx.src.entry");
    case "day":
      return r.book === "store" ? t("plTx.src.dayStore") : t("plTx.src.dayMsb");
    case "service":
      return t("plTx.src.service");
    case "money_order_charges":
      return tn("plTx.src.moCharges", Number(r.item_kind) || 0, fmtNumber);
    case "returned_checks":
      return t("plTx.src.returnedChecks");
    case "typed":
      return t("plTx.src.typed");
  }
}

export function PLTransactions({
  year, month, labels,
}: {
  year: number;
  month: number;
  /** The store's own name per P&L line. */
  labels: Record<string, string>;
}) {
  const tr = useT();
  const qc = useQueryClient();
  const url = useUrlFilterState(
    { view: "", line: "", source: "", q: "" },
    { pageSizeKey: "pl-transactions" },
  );
  const { params, setParam } = url;
  const view = (VIEWS.some((v) => v.view === params.view) ? params.view : "all") as PLTransactionView;
  const filters: PLTransactionFilters = {
    view,
    line: params.line,
    source: params.source as PLTransactionFilters["source"],
    q: params.q.length >= 2 ? params.q : "",
    page: url.page,
    per_page: url.perPage,
  };
  const list = usePLTransactions(year, month, filters, true);
  const canTag = hasPermission("bank_sync", "update");
  // Putting a daily entry on another line edits the P&L, not the bank.
  const canMove = hasPermission("monthly", "update");
  const categories = useBankCategories(canTag);
  const groups = categories.data?.groups;
  const catLabels = useMemo(() => categoryLabels(groups), [groups]);
  const bookable = useMemo(() => dailyBookSlugs(groups), [groups]);
  const [ruleFor, setRuleFor] = useState<RuleSourceRow | null>(null);
  const [accepting, setAccepting] = useState(false);
  const toast = useToast();
  const data = list.data;
  const targets = useMemo(() => data?.entry_targets ?? [], [data]);
  const targetLabels = useMemo(
    () => new Map(targets.map((x) => [x.slug, x.label])), [targets],
  );

  /** "Accept" one row's suggestion, or every one ("Accept all"). */
  const accept = useCallback(async (txnIds: number[] = [], entryIds: number[] = []) => {
    setAccepting(true);
    try {
      const res: PLAcceptResponse = await acceptPLSuggestions(year, month, txnIds, entryIds);
      const left = res.locked + res.maybe_in_daily_book;
      toast({
        message: tn("plTx.accepted", res.accepted, fmtNumber)
          + (left ? ` ${tn("plTx.acceptLeft", left, fmtNumber)}` : ""),
        tone: res.accepted ? "success" : "info",
      });
      void qc.invalidateQueries({ queryKey: ["monthly"] });
      void qc.invalidateQueries({ queryKey: ["bank"] });
    } catch (e) {
      toast({ message: apiErrorMessage(e, t("plTx.acceptFailed")), tone: "error" });
    } finally {
      setAccepting(false);
    }
  }, [year, month, toast, qc]);

  const columns = useMemo<DataColumn<PLTransactionRow>[]>(() => {
    function refresh() {
      void qc.invalidateQueries({ queryKey: ["monthly"] });
      void qc.invalidateQueries({ queryKey: ["bank"] });
    }
    return [
      {
        key: "day", header: tr("plTx.colDay"),
        render: (r) => (
          <span className={styles.day}>
            {r.day ? formatDate(r.day) : tr("plTx.wholeMonth")}
          </span>
        ),
        csv: (r) => (r.day ? csvDate(r.day) : ""),
      },
      {
        key: "description", header: tr("plTx.colDescription"),
        render: (r) => (
          <span className={styles.description}>
            <span>{plSourceText(r)}</span>
            {r.account_label && <span className={styles.sub}>{r.account_label}</span>}
          </span>
        ),
        csv: (r) => plSourceText(r),
      },
      {
        key: "line", header: tr("plTx.colLine"),
        render: (r) => {
          if (r.txn_id != null && canTag && RECATEGORIZABLE.has(r.status)) {
            const txnId = r.txn_id;
            const suggestion = r.status === "to_review" && r.suggested_slug ? (
              <span className={styles.suggestion}>
                <span
                  title={tr(r.suggested_source === "template"
                    ? "plTx.suggestedTemplate" : "plTx.suggestedHistory")}
                >
                  {tr("plTx.suggested", {
                    category: catLabels.get(r.suggested_slug) ?? r.suggested_slug,
                  })}
                </span>
                <Button
                  size="sm" tone="secondary" disabled={accepting}
                  onClick={() => { void accept([txnId]); }}
                >
                  {tr("plTx.accept")}
                </Button>
              </span>
            ) : null;
            return (
              <>
              {suggestion}
              <BankCategoryCell
                row={{
                  id: txnId,
                  category_slug: r.category_slug,
                  booked_on: r.booked_on ?? "",
                  report_date_override: r.report_date_override ?? "",
                  bank_date: r.bank_date ?? "",
                }}
                groups={groups}
                labels={catLabels}
                bookable={bookable}
                onChanged={refresh}
                onMakeRule={() => setRuleFor({
                  id: txnId,
                  description: r.description,
                  amount_cents: Math.round((r.bank_amount ?? 0) * 100),
                  category_slug: r.category_slug,
                })}
              />
              </>
            );
          }
          if (r.entry_id != null && canMove && ENTRY_KIND_LINES[r.item_kind]) {
            const entryId = r.entry_id;
            const own = ENTRY_KIND_LINES[r.item_kind];
            const suggested = !r.entry_category && r.suggested_slug && r.txn_id == null
              ? targetLabels.get(r.suggested_slug) : undefined;
            return (
              <>
              {suggested && (
                <span className={styles.suggestion}>
                  <span title={tr("plTx.suggestedEntry")}>
                    {tr("plTx.suggested", { category: suggested })}
                  </span>
                  <Button
                    size="sm" tone="secondary" disabled={accepting}
                    onClick={() => { void accept([], [entryId]); }}
                  >
                    {tr("plTx.accept")}
                  </Button>
                </span>
              )}
              <EntryLineSelect
                value={r.entry_category}
                ownLine={monthlyLineName(own, labels[own])}
                targets={targets}
                label={tr("plTx.entryLineFor", { entry: plSourceText(r) })}
                onPick={async (slug) => {
                  try {
                    await setEntryCategory(entryId, slug);
                    refresh();
                  } catch (e) {
                    toast({ message: apiErrorMessage(e, t("plTx.entryFailed")), tone: "error" });
                  }
                }}
              />
              </>
            );
          }
          return r.line
            ? monthlyLineName(r.line, labels[r.line])
            : <span className={styles.sub}>{tr("plTx.noLine")}</span>;
        },
        csv: (r) => (r.line ? monthlyLineName(r.line, labels[r.line]) : ""),
      },
      {
        key: "status", header: tr("plTx.colStatus"),
        render: (r) => (
          <Pill tone={STATUS[r.status].tone}>{tr(STATUS[r.status].label)}</Pill>
        ),
        csv: (r) => tr(STATUS[r.status].label),
      },
      {
        key: "amount", header: tr("plTx.colAmount"), align: "right",
        render: (r) => (
          <span className={r.counted ? styles.amount : styles.amountMuted}>
            {fmtMoney2(r.amount)}
          </span>
        ),
        csv: (r) => csvMoney(r.amount),
      },
    ];
  }, [
    tr, qc, canTag, canMove, groups, catLabels, bookable, labels, accept,
    accepting, targets, targetLabels, toast,
  ]);

  const toReview = data?.counts.review ?? 0;

  return (
    <div className={styles.wrap}>
      {data && (
        <p className={styles.banner} data-testid="pl-completeness">
          {toReview > 0 ? (
            <Button
              tone="ghost" size="sm"
              onClick={() => setParam("view", "review")}
            >
              {tn("plTx.toReview", toReview, fmtNumber)}
            </Button>
          ) : (
            <Pill tone="accent" dot>{tr("plTx.allReviewed")}</Pill>
          )}
          {(canTag || canMove) && data.suggested > 0 && (
            <Button
              size="sm" busy={accepting} disabled={accepting}
              onClick={() => { void accept(); }}
            >
              {tn("plTx.acceptAll", data.suggested, fmtNumber)}
            </Button>
          )}
          <span>
            {tr("plTx.daysEntered", {
              days: fmtNumber(data.days_entered),
              of: fmtNumber(data.days_in_month),
            })}
          </span>
        </p>
      )}

      <TabsBar>
        {VIEWS.map((v) => (
          <TabsButton
            key={v.view}
            active={view === v.view}
            onClick={() => setParam("view", v.view)}
          >
            {tr(v.label, { count: data ? fmtNumber(data.counts[v.view]) : "—" })}
          </TabsButton>
        ))}
      </TabsBar>

      <DataTable
        toolbar={(
          <div className={styles.toolbar}>
            <Input
              type="search"
              aria-label={tr("plTx.search")}
              placeholder={tr("plTx.search")}
              value={url.draft.q ?? params.q}
              onChange={(e) => url.debounced("q", e.target.value)}
            />
            <Select
              aria-label={tr("plTx.line")}
              value={params.line}
              onChange={(e) => setParam("line", e.target.value)}
            >
              <option value="">{tr("plTx.anyLine")}</option>
              {MONTHLY_LINES.filter((l) => l.key !== "cash_carry_forward").map((l) => (
                <option key={l.key} value={l.key}>
                  {monthlyLineName(l.key, labels[l.key])}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("plTx.source")}
              value={params.source}
              onChange={(e) => setParam("source", e.target.value)}
            >
              <option value="">{tr("plTx.anySource")}</option>
              <option value="bank">{tr("plTx.sourceBank")}</option>
              <option value="daily">{tr("plTx.sourceDaily")}</option>
              <option value="other">{tr("plTx.sourceOther")}</option>
            </Select>
          </div>
        )}
        columns={columns}
        rows={data?.rows}
        rowKey={(r) => r.key}
        rowClassName={(r) => (r.counted ? undefined : styles.notCounted)}
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        onRetry={() => { void list.refetch(); }}
        emptyTitle={view === "review" ? tr("plTx.emptyReview") : tr("plTx.empty")}
        page={data && {
          page: data.page,
          totalPages: data.total_pages,
          total: data.total,
          onPage: url.setPage,
          perPage: url.perPage,
          onPerPage: url.setPerPage,
        }}
        exportCsv={{
          filename: `pl-transactions-${year}-${String(month).padStart(2, "0")}`,
          fetchPage: (page, perPage) => fetchPLTransactions(year, month, {
            ...filters, page, per_page: perPage,
          }),
        }}
      />

      <BankRuleFromRow row={ruleFor} onClose={() => setRuleFor(null)} />
    </div>
  );
}

/** The expense line a daily entry counts on: its own (first), or one
 *  of the store's expense lines and categories. Saves on pick. */
function EntryLineSelect({
  value, ownLine, targets, label, onPick,
}: {
  value: string;
  ownLine: string;
  targets: PLEntryTarget[];
  label: string;
  onPick: (slug: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const known = value === "" || targets.some((x) => x.slug === value);
  return (
    <Select
      value={value} aria-label={label} disabled={busy}
      className={styles.entrySelect}
      onChange={(e) => {
        setBusy(true);
        void onPick(e.target.value).finally(() => setBusy(false));
      }}
    >
      <option value="">{t("plTx.ownLine", { line: ownLine })}</option>
      {!known && <option value={value}>{value}</option>}
      {targets.map((x) => (
        <option key={x.slug} value={x.slug}>{x.label}</option>
      ))}
    </Select>
  );
}

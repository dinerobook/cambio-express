import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  MONTHLY_LINES,
  MONTHLY_SECTION_LABELS,
  monthlyLineName,
  monthlyLineSource,
  updateMonthly,
  useMonthly,
  type MonthlyLine,
  type MonthlyLineSource,
  type MonthlyRow,
  type MonthlySection,
  type MonthlyUpdateBody,
} from "../api/monthly";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Button, Card, ErrorState, FormActions,
  Loading, MoneyInput, PageHeader, PageShell, Textarea, useToast,
} from "../components/ui";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./EditMonthly.module.css";
import { monthName } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tNodes, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// Edit page for the monthly P&L at /app/monthly/edit?year=Y&month=M.
//
// Only the lines the operator types are fields here (MONTHLY_LINES
// `editable`); the daily-derived lines, money order fees and the
// returned-check line are the server's and never in the PUT. Of the
// typed lines, those the bank feed (`bank_locked`) or the daily books
// (`daily_fed`) fill this month render read-only with the live
// figure and are left out of the PUT — the server writes its own.

const FIELDS = MONTHLY_LINES.filter((l) => l.editable) as Array<
  MonthlyLine & { key: keyof MonthlyUpdateBody & keyof MonthlyRow }
>;

const SECTIONS: MonthlySection[] = ["Income", "Expenses", "Cash flow"];

const LOCKED_HINTS: Partial<Record<MonthlyLineSource, MessageKey>> = {
  bank: "pl.lockedBank",
  daily: "pl.lockedDaily",
};

export default function EditMonthly() {
  useT(); // re-render on a language switch
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const [sp]     = useSearchParams();
  // Number(null) is 0, which counts as "finite" — a missing param must
  // stay NaN so the "Missing year or month" guard below fires and no
  // /monthly/0/0 request goes out.
  const year  = Number(sp.get("year") || NaN);
  const month = Number(sp.get("month") || NaN);

  const detail = useMonthly(
    Number.isFinite(year) ? year : undefined,
    Number.isFinite(month) ? month : undefined,
  );

  const [form, setForm] = useState<MonthlyUpdateBody | null>(null);
  // Baseline = last server-synced form; drives the unsaved-changes guard.
  const [baseline, setBaseline] = useState<MonthlyUpdateBody | null>(null);
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState<string | null>(null);

  // Only a successful load builds the form: a failed one renders
  // <ErrorState> below, never a zero form whose Save would PUT zeros
  // over the real month.
  useEffect(() => {
    if (detail.isLoading || detail.isFetching || detail.isError) return;
    if (detail.data === undefined) return;
    const r = detail.data.report ?? null;
    const init: MonthlyUpdateBody = { notes: r?.notes ?? "" };
    for (const f of FIELDS) {
      const v = r ? (r as unknown as Record<string, number>)[f.key] : 0;
      (init as Record<string, number>)[f.key] = (v ?? 0) as number;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable form + dirty baseline from server-fetched monthly P&L row once the GET resolves
    setForm(init);
    setBaseline(init);
  }, [detail.data, detail.isLoading, detail.isFetching, detail.isError]);

  const report = detail.data?.report ?? null;
  // A line the bank or the daily books fill this month is theirs.
  const lockedSource = (key: string): MonthlyLineSource | null => {
    if (!report) return null;
    const source = monthlyLineSource(report, key);
    return source === "bank" || source === "daily" ? source : null;
  };
  // The store's own name per line; absent keys fall back to FIELDS.
  const labels = detail.data?.labels ?? {};

  const isDirty =
    form != null && baseline != null &&
    JSON.stringify(form) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("pl.unsaved"),
  });

  function set<K extends keyof MonthlyUpdateBody>(
    key: K, value: MonthlyUpdateBody[K],
  ) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form || !Number.isFinite(year) || !Number.isFinite(month) ||
        identity?.store_id == null) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const body: MonthlyUpdateBody = { notes: form.notes ?? "" };
      for (const f of FIELDS) {
        // A bank- or daily-fed line is the server's to write; sending
        // the displayed sum back would be harmless but misleading.
        if (lockedSource(f.key)) continue;
        const v = form[f.key];
        if (typeof v === "number" || typeof v === "string") {
          (body as Record<string, number>)[f.key] = Number(v) || 0;
        }
      }
      await updateMonthly(year, month, body);
      // The P&L page, the month list and the dashboards read cached
      // copies of this month; without this they show the old numbers
      // until the cache goes stale.
      void queryClient.invalidateQueries({ queryKey: ["monthly"] });
      toast({ message: t("pl.saved"), tone: "success" });
      guard.proceed(() => navigate(`/monthly?year=${year}&month=${month}`, { replace: true }));
    } catch (e) {
      setErr(apiErrorMessage(e, t("pl.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title={t("pl.editTitle")} />
        <p>{t("pl.signInEdit")}</p>
      </PageShell>
    );
  }

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return (
      <PageShell>
        <PageHeader title={t("pl.editTitle")} />
        <p>{t("pl.missingMonth")}</p>
      </PageShell>
    );
  }

  if (detail.isError && detail.data === undefined) {
    return (
      <PageShell>
        <PageHeader title={t("pl.editTitle")} />
        <ErrorState
          message={t("pl.loadMonthFailed")}
          onRetry={() => void detail.refetch()}
          busy={detail.isFetching}
        />
      </PageShell>
    );
  }

  if (detail.isLoading || form == null) {
    return (
      <PageShell>
        <Loading />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <header>

        <PageCrumbs
          under="/reports"
          via={[{ label: navWord("Monthly P&L"), to: "/monthly" }]}
          current={t("common.edit")}
        />

        <PageHeader title={t("pl.editTitle")} />
        <p className={styles.headerMono}>
          {monthName(month, "short")} {year}
        </p>
        <p className={styles.headerNote}>{t("pl.editNote")}</p>
        <p className={styles.headerNote}>
          {tNodes("pl.renameNote", {
            link: (
              <AppLink to="/monthly/categories">{t("pl.renameLink")}</AppLink>
            ),
          })}
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="ds-form"
      >
        {SECTIONS.map((sec) => (
          <Card key={sec}>
            <h2 className={styles.sectionTitle}>{t(MONTHLY_SECTION_LABELS[sec])}</h2>
            <div className={styles.fieldGrid}>
              {FIELDS.filter((f) => f.section === sec).map((f) => {
                const locked = lockedSource(f.key);
                return (
                  <MoneyInput
                    key={f.key}
                    label={monthlyLineName(f.key, labels[f.key])}
                    value={
                      typeof form[f.key] === "number"
                        ? (form[f.key] as number)
                        : 0
                    }
                    onChange={(v) => set(f.key, v as never)}
                    readOnly={locked != null}
                    disabled={locked != null}
                    hint={locked && LOCKED_HINTS[locked] ? t(LOCKED_HINTS[locked]) : undefined}
                  />
                );
              })}
            </div>
          </Card>
        ))}

        <Card>
          <h2 className={styles.sectionTitle}>{t("pl.notes")}</h2>
          <Textarea
            value={form.notes ?? ""}
            onChange={(e) => set("notes", e.target.value)}
            rows={4}
          />
        </Card>

        {err && <Alert tone="error">{err}</Alert>}

        <FormActions guard={guard}>
          <Button
            type="button"
            tone="secondary"
            onClick={() => guard.confirmLeave(
              () => navigate(`/monthly?year=${year}&month=${month}`),
            )}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </FormActions>
      </form>
    </PageShell>
  );
}

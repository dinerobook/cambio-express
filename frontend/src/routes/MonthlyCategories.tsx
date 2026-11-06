import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  MONTHLY_SECTION_LABELS, monthlyLineName,
  updateMonthlyLabels, useMonthlyLabels,
  type MonthlyLineLabel,
} from "../api/monthly";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Button, Card, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, Pill,
  useToast,
} from "../components/ui";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./MonthlyCategories.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// P&L categories at /app/monthly/categories.
//
// What this page is really for: the P&L ships with the names the
// first customers used — Boost Mobile, money order rent, EmagineNet
// / tech — and a store in another line of business recognises about
// half of them. Here it uses its own words.
//
// What it is NOT: a way to add a line. The P&L is a fixed set of
// columns because the totals, the tax export and the bank feed are
// built on them, and a column has to mean the same thing in January
// and in December. The five blank expense slots and three blank
// income slots exist to be claimed — naming one is how a store gets
// a category we did not ship, and it is also what puts that
// category in the bank-rule picker.
//
// Renaming moves no money: last month's numbers stay in the same
// column and every bank rule keeps pointing at it.

const SECTIONS: Array<MonthlyLineLabel["section"]> = ["Income", "Expenses"];

export default function MonthlyCategories() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const toast = useToast();
  const qc = useQueryClient();
  const lines = useMonthlyLabels();

  // field → what's in the box. Empty means "use the default",
  // which is exactly what the server does with an empty value.
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [baseline, setBaseline] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rows = useMemo(() => lines.data?.lines ?? [], [lines.data]);

  useEffect(() => {
    if (lines.isLoading || lines.isFetching) return;
    const init: Record<string, string> = {};
    for (const r of rows) init[r.field] = r.is_custom ? r.label : "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable draft + dirty baseline from the server's line list once the GET resolves
    setDraft(init);
    setBaseline(init);
  }, [rows, lines.isLoading, lines.isFetching]);

  const isDirty =
    draft != null && baseline != null &&
    JSON.stringify(draft) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("cat.unsaved"),
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!draft || !baseline) return;
    setErr(null);
    setBusy(true);
    try {
      // Send only what moved — the endpoint is a partial update,
      // and a no-op field would write an audit row for nothing.
      const changed: Record<string, string> = {};
      for (const [field, value] of Object.entries(draft)) {
        if (value !== baseline[field]) changed[field] = value;
      }
      if (Object.keys(changed).length === 0) {
        toast({ message: t("cat.nothingToSave"), tone: "info" });
        return;
      }
      await updateMonthlyLabels(changed);
      setBaseline(draft);
      toast({ message: t("cat.saved"), tone: "success" });
      // The bank-category picker and every month on screen read
      // these names, so drop both caches rather than just this one.
      void qc.invalidateQueries({ queryKey: ["monthly"] });
      void qc.invalidateQueries({ queryKey: ["bank"] });
    } catch (e) {
      setErr(apiErrorMessage(e, t("cat.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title={t("cat.title")} />
        <p>{t("cat.signIn")}</p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs
        under="/reports"
        via={[{ label: navWord("Monthly P&L"), to: "/monthly" }]}
        current={t("pl.categoriesButton")}
      />

      <PageHeader title={t("cat.title")} subtitle={t("cat.subtitle")} />

      <p className={styles.intro}>{t("cat.intro1")}</p>
      <p className={styles.intro}>
        {tNodes("cat.intro2", {
          link: <AppLink to="/bank/rules">{t("cat.bankRuleLink")}</AppLink>,
        })}
      </p>

      {lines.isLoading && <Loading />}
      {lines.isError && (
        <ErrorState
          message={
            apiErrorMessage(lines.error, t("cat.loadFailed"))
          }
          onRetry={() => { void lines.refetch(); }}
        />
      )}

      {draft && !lines.isError && (
        <form onSubmit={onSubmit} className="ds-form">
          {err && <Alert tone="error">{err}</Alert>}

          {SECTIONS.map((section) => (
            <Card key={section}>
              <h2 className={styles.sectionTitle}>
                {t(MONTHLY_SECTION_LABELS[section])}
              </h2>
              <div className={styles.lineGrid}>
                {rows.filter((r) => r.section === section).map((r) => {
                  // The shipped name, in the person's language.
                  const shipped = monthlyLineName(r.field, r.default_label);
                  return (
                  <Field
                    key={r.field}
                    label={shipped}
                    hint={hintFor(r)}
                  >
                    <div className={styles.lineRow}>
                      <Input
                        value={draft[r.field] ?? ""}
                        placeholder={shipped}
                        maxLength={60}
                        aria-label={t("cat.nameFor", { name: shipped })}
                        onChange={(e) => setDraft((d) => (
                          d ? { ...d, [r.field]: e.target.value } : d
                        ))}
                      />
                      {r.is_slot && (
                        <Pill tone={draft[r.field] ? "accent" : "neutral"}>
                          {draft[r.field] ? t("cat.inUse") : t("cat.freeSlot")}
                        </Pill>
                      )}
                    </div>
                  </Field>
                  );
                })}
              </div>
            </Card>
          ))}

          <FormActions guard={guard}>
            <Button type="submit" tone="primary" disabled={busy || !isDirty}>
              {busy ? t("common.saving") : t("cat.saveNames")}
            </Button>
          </FormActions>
        </form>
      )}
    </PageShell>
  );
}

function hintFor(r: MonthlyLineLabel): string | undefined {
  if (r.is_slot) {
    return t("cat.hintSlot");
  }
  if (!r.bank_taggable) {
    return t("cat.hintNotTaggable");
  }
  return undefined;
}

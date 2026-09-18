import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  updateMonthlyLabels, useMonthlyLabels,
  type MonthlyLineLabel,
} from "../api/monthly";
import { ApiError } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Breadcrumbs, Button, Card, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, Pill,
  useToast,
} from "../components/ui";
import { useUnsavedChangesGuard } from "../lib/useUnsavedChangesGuard";
import styles from "./MonthlyCategories.module.css";

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
  // The page has no Cancel control to intercept, so the browser's
  // own "Leave site?" prompt is the whole guard here.
  useUnsavedChangesGuard(isDirty && !busy);

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
        toast({ message: "Nothing to save.", tone: "info" });
        return;
      }
      await updateMonthlyLabels(changed);
      setBaseline(draft);
      toast({ message: "Category names saved.", tone: "success" });
      // The bank-category picker and every month on screen read
      // these names, so drop both caches rather than just this one.
      void qc.invalidateQueries({ queryKey: ["monthly"] });
      void qc.invalidateQueries({ queryKey: ["bank"] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not save names.");
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title="P&L categories" />
        <p>Sign in as a store admin to manage P&amp;L categories.</p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <Breadcrumbs crumbs={[
        { label: "Monthly P&L", to: "/monthly" },
        { label: "Categories" },
      ]} />

      <PageHeader
        title="P&L categories"
        subtitle="Name the lines on your P&L the way your business does."
      />

      <p className={styles.intro}>
        Renaming a line changes what you read and nothing else —
        the money stays where it is, closed months keep their
        numbers, and bank rules keep working. Leave a box empty to
        go back to the name we ship.
      </p>
      <p className={styles.intro}>
        The blank slots are how you add a category we did not think
        of. Name one and it turns up in the{" "}
        <AppLink to="/bank/rules">bank rule</AppLink> picker, ready
        to tag transactions into.
      </p>

      {lines.isLoading && <Loading />}
      {lines.isError && (
        <ErrorState
          message={
            lines.error instanceof Error
              ? lines.error.message
              : "Could not load P&L categories"
          }
          onRetry={() => { void lines.refetch(); }}
        />
      )}

      {draft && (
        <form onSubmit={onSubmit} className="ds-form">
          {err && <Alert tone="error">{err}</Alert>}

          {SECTIONS.map((section) => (
            <Card key={section}>
              <h2 className={styles.sectionTitle}>{section}</h2>
              <div className={styles.lineGrid}>
                {rows.filter((r) => r.section === section).map((r) => (
                  <Field
                    key={r.field}
                    label={r.default_label}
                    hint={hintFor(r)}
                  >
                    <div className={styles.lineRow}>
                      <Input
                        value={draft[r.field] ?? ""}
                        placeholder={r.default_label}
                        maxLength={60}
                        aria-label={`Name for ${r.default_label}`}
                        onChange={(e) => setDraft((d) => (
                          d ? { ...d, [r.field]: e.target.value } : d
                        ))}
                      />
                      {r.is_slot && (
                        <Pill tone={draft[r.field] ? "accent" : "neutral"}>
                          {draft[r.field] ? "In use" : "Free slot"}
                        </Pill>
                      )}
                    </div>
                  </Field>
                ))}
              </div>
            </Card>
          ))}

          <FormActions>
            <Button type="submit" tone="primary" disabled={busy || !isDirty}>
              {busy ? "Saving…" : "Save names"}
            </Button>
          </FormActions>
        </form>
      )}
    </PageShell>
  );
}

function hintFor(r: MonthlyLineLabel): string | undefined {
  if (r.is_slot) {
    return "Blank slot — name it to use it as a category.";
  }
  if (!r.bank_taggable) {
    return "Typed on the P&L. The register feeds this line, so bank "
      + "transactions can't be tagged into it.";
  }
  return undefined;
}

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  deleteRegisterClose, upsertRegisterClose, useDayClose, useDepartments,
  type Department, type RegisterClose,
} from "../api/dayclose";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import {
  Alert, Button, ButtonLink, Card, EmptyState, ErrorState, Field,
  InfoTip, Input, KpiCard, KpiGrid, Loading, Modal, MoneyInput, RowActions, Section,
  Table, Textarea, tdStyle, thStyle, useToast,
} from "./ui";
import styles from "./RegisterCloses.module.css";

// The per-register Z-report detail for ONE day.
//
// This used to be the whole /day-close page. It now lives inside the
// store daily book's day (a store closes its day once, in one place),
// so the date belongs to the page and this component only ever takes
// the day it is told to show.
//
// `canEdit` follows the day's lock: a locked sheet shows its register
// detail read-only, exactly like every money field above it.

export default function RegisterCloses({
  day, canEdit = true,
}: {
  day: string;
  canEdit?: boolean;
}) {
  const summary = useDayClose(day);
  const departments = useDepartments();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [editing, setEditing] = useState<RegisterClose | null>(null);
  const [adding, setAdding] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["dayclose", "day"] });
  }

  async function remove(close: RegisterClose) {
    try {
      await deleteRegisterClose(close.id);
      refresh();
      toast({ message: "Register close removed.", tone: "success" });
    } catch (err) {
      toastApiError(err, "Could not remove the close.");
    }
  }

  const data = summary.data;
  return (
    <Section
      title={
        <>
          Registers
          <InfoTip text="Each register or shift Z-report — sales, tax, and tender totals plus the department breakdown. Drawer over/short computes from the counted cash. Imported register data lands here too." />
        </>
      }
      actions={canEdit ? (
        <div className={styles.actions}>
          {/* The register-import entry point moved here with the
              section — it was the Day close page's header action. */}
          <ButtonLink to="/pos-import" size="sm" tone="secondary">
            Import from register
          </ButtonLink>
          <Button size="sm" perm="day_close.create" onClick={() => setAdding(true)}>
            + Add close
          </Button>
        </div>
      ) : undefined}
    >
      {summary.isLoading && <Loading />}
      {summary.isError && (
        <ErrorState
          message="Could not load the day's registers."
          onRetry={() => { void summary.refetch(); }}
        />
      )}
      {data && data.closes.length === 0 && (
        <EmptyState
          title="No register closes for this day"
          body={canEdit
            ? 'Click "+ Add close" to key the first Z-report, or import it from the register.'
            : "Nothing was keyed or imported for this day."}
        />
      )}
      {data && data.closes.length > 0 && (
        <>
          <KpiGrid>
            <KpiCard label="Gross sales" value={fmtMoney2(data.gross_sales)} />
            <KpiCard label="Sales tax" value={fmtMoney2(data.sales_tax)} />
            <KpiCard
              label="Drawer over / short"
              value={
                data.over_short == null ? "—" : fmtMoney2(data.over_short)
              }
              tone={
                data.over_short == null || data.over_short === 0
                  ? "positive" : "negative"
              }
            />
            <KpiCard
              label="Uncounted drawers"
              value={String(data.uncounted_drawers)}
              tone={data.uncounted_drawers > 0 ? "negative" : "positive"}
            />
          </KpiGrid>
          <Card>
            <Table>
              <thead>
                <tr>
                  {["Register", "Gross", "Tax", "Cash", "Card", "Other",
                    "Counted", "Over/short",
                    ...(canEdit ? ["Actions"] : [])].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.closes.map((c) => (
                  <tr
                    key={c.id}
                    className={
                      c.cash_counted == null ? styles.uncountedRow : ""
                    }
                  >
                    <td style={tdStyle}>
                      {c.register_label}
                      {c.shift_label ? ` / ${c.shift_label}` : ""}
                    </td>
                    <td style={tdStyle}>{fmtMoney2(c.gross_sales)}</td>
                    <td style={tdStyle}>{fmtMoney2(c.sales_tax)}</td>
                    <td style={tdStyle}>{fmtMoney2(c.cash_total)}</td>
                    <td style={tdStyle}>{fmtMoney2(c.card_total)}</td>
                    <td style={tdStyle}>{fmtMoney2(c.other_total)}</td>
                    <td style={tdStyle}>
                      {c.cash_counted == null
                        ? "—" : fmtMoney2(c.cash_counted)}
                    </td>
                    <td style={tdStyle}>
                      {c.over_short == null
                        ? "—" : fmtMoney2(c.over_short)}
                    </td>
                    {canEdit && (
                      <td style={tdStyle}>
                        <RowActions
                          title={c.register_label}
                          actions={[
                            {
                              label: "Edit",
                              perm: "day_close.update",
                              tone: "primary",
                              onClick: () => setEditing(c),
                            },
                            {
                              label: "Delete",
                              perm: "day_close.update",
                              tone: "warning",
                              onClick: () => remove(c),
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {data.department_totals.length > 0 && (
            <Card>
              <Table>
                <thead>
                  <tr>
                    <th style={thStyle}>Department</th>
                    <th style={thStyle}>Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {data.department_totals.map((t) => (
                    <tr key={t.department_id}>
                      <td style={tdStyle}>{t.department_name}</td>
                      <td style={tdStyle}>{fmtMoney2(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </>
      )}
      <CloseModal
        open={canEdit && (adding || editing != null)}
        day={day}
        existing={editing}
        departments={departments.data?.departments ?? []}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); refresh(); }}
      />
    </Section>
  );
}

// ── Close modal (add / edit one register-shift Z-report) ─────

function CloseModal({
  open, day, existing, departments, onClose, onDone,
}: {
  open: boolean;
  day: string;
  existing: RegisterClose | null;
  departments: Department[];
  onClose: () => void;
  onDone: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          {existing ? "Edit register close" : "Add register close"}
          <InfoTip text="Key the Z-report as printed. Re-saving the same register and shift replaces the earlier entry. Leave counted cash blank until the drawer is actually counted — blank is 'not counted yet', not $0." />
        </>
      }
    >
      {open && (
        // Keyed remount resets the form per open/target — prefill
        // via initializers, no state-sync effect needed.
        <CloseForm
          key={existing?.id ?? "new"}
          day={day}
          existing={existing}
          departments={departments}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

function CloseForm({
  day, existing, departments, onClose, onDone,
}: {
  day: string;
  existing: RegisterClose | null;
  departments: Department[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [registerLabel, setRegisterLabel] = useState(
    existing?.register_label ?? "Register 1",
  );
  const [shiftLabel, setShiftLabel] = useState(existing?.shift_label ?? "");
  const [gross, setGross] = useState(existing?.gross_sales ?? 0);
  const [tax, setTax] = useState(existing?.sales_tax ?? 0);
  const [cash, setCash] = useState(existing?.cash_total ?? 0);
  const [card, setCard] = useState(existing?.card_total ?? 0);
  const [other, setOther] = useState(existing?.other_total ?? 0);
  const [counted, setCounted] = useState(
    existing?.cash_counted != null ? String(existing.cash_counted) : "",
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [deptAmounts, setDeptAmounts] = useState<Record<number, number>>(
    () => {
      const amounts: Record<number, number> = {};
      for (const line of existing?.department_sales ?? []) {
        amounts[line.department_id] = line.amount;
      }
      return amounts;
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const lines = departments
      .map((d) => ({
        department_id: d.id,
        amount: deptAmounts[d.id] ?? 0,
      }))
      .filter((l) => l.amount > 0);
    try {
      await upsertRegisterClose(day, {
        register_label: registerLabel.trim(),
        shift_label: shiftLabel.trim(),
        gross_sales: gross,
        sales_tax: tax,
        cash_total: cash,
        card_total: card,
        other_total: other,
        cash_counted:
          counted.trim() === "" ? null : Number.parseFloat(counted) || 0,
        notes: notes.trim(),
        department_sales: lines,
      });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.modalForm}>
      {error && <Alert tone="error">{error}</Alert>}
      <div className={styles.moneyGrid}>
        <Field label="Register">
          <Input
            type="text" value={registerLabel} required maxLength={40}
            disabled={existing != null}
            onChange={(e) => setRegisterLabel(e.target.value)}
          />
        </Field>
        <Field label="Shift (optional)">
          <Input
            type="text" value={shiftLabel} maxLength={40}
            placeholder="e.g. Morning"
            disabled={existing != null}
            onChange={(e) => setShiftLabel(e.target.value)}
          />
        </Field>
        <MoneyInput label="Gross sales" value={gross} onChange={setGross} fullWidth />
        <MoneyInput label="Sales tax" value={tax} onChange={setTax} fullWidth />
        <MoneyInput label="Cash tender" value={cash} onChange={setCash} fullWidth />
        <MoneyInput label="Card tender" value={card} onChange={setCard} fullWidth />
        <MoneyInput label="Other tender" value={other} onChange={setOther} fullWidth />
        {/* Not a MoneyInput on purpose: blank means "not counted"
            (null, no variance) and 0 means "counted, drawer empty".
            MoneyInput renders 0 as blank, so it would merge the two. */}
        <Field label="Counted drawer cash">
          <Input
            type="number" min={0} step="0.01" value={counted}
            placeholder="Blank = not counted"
            onChange={(e) => setCounted(e.target.value)}
          />
        </Field>
      </div>
      {departments.length > 0 && (
        <Field label="Department sales">
          <div className={styles.modalForm}>
            {departments.map((d) => (
              <div key={d.id} className={styles.deptRow}>
                <span className={styles.deptName}>{d.name}</span>
                <MoneyInput
                  aria-label={`${d.name} sales`}
                  value={deptAmounts[d.id] ?? 0}
                  onChange={(next) =>
                    setDeptAmounts((prev) => ({ ...prev, [d.id]: next }))
                  }
                />
              </div>
            ))}
          </div>
        </Field>
      )}
      <Field label="Notes (optional)">
        <Textarea
          value={notes} maxLength={500} rows={2}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <div className={styles.modalActions}>
        <Button tone="secondary" type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" busy={busy} disabled={busy}>
          {existing ? "Save changes" : "Add close"}
        </Button>
      </div>
    </form>
  );
}

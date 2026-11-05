import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createShift,
  deleteShift,
  updateShift,
  useShifts,
  type ShiftRow,
} from "../api/timeclock";
import { useEmployees } from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import {
  Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, PeriodStepper, Select, useToast,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./AdminTimeClockSchedule.module.css";
import {
  addDaysIso, formatWeekRange, mondayOfIso, todayIso, weekdayNamesShort,
  weekdayOfIso,
} from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/admin/timeclock/schedule — admin shift planner.
//
// v1 layout: a 7-day grid for the picked week, one column per
// day, one card per scheduled shift inside the column.  Click
// "Add shift" → inline form at the top of the column for that
// day.  Click an existing shift → inline form to edit / delete.
// Punches (TimeClockEntry) are tracked separately — this page
// is the operator's PLAN, not the actual punches.  Late-arrival
// / no-show derivation against actual punches is a follow-up.

export default function AdminTimeClockSchedule() {
  const queryClient = useQueryClient();
  const roster      = useEmployees();
  // The week's Monday as YYYY-MM-DD; weekEnd is the exclusive end
  // (the next Monday), as the shifts API takes it.
  const [weekStart, setWeekStart] = useState(() => mondayOfIso(todayIso()));
  const weekEnd     = addDaysIso(weekStart, 7);
  const shifts      = useShifts(weekStart, weekEnd);
  const toast = useToast();
  const t = useT();

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["timeclock", "shifts"] });
  }

  const shiftsByDay = useMemo(() => {
    const map = new Map<string, ShiftRow[]>();
    for (const s of shifts.data?.rows ?? []) {
      const list = map.get(s.shift_date) ?? [];
      list.push(s);
      map.set(s.shift_date, list);
    }
    return map;
  }, [shifts.data]);

  if (roster.isError) {
    return (
      <PageShell>
        <PageHeader title={navWord("Schedule")} />
        <ErrorState
          message={t("schedule.rosterFailed")}
          onRetry={() => { void roster.refetch(); }}
        />
      </PageShell>
    );
  }
  if (roster.isLoading) {
    return (
      <PageShell>
        <PageHeader title={navWord("Schedule")} />
        <Loading />
      </PageShell>
    );
  }
  const activeRoster = roster.data?.employees ?? [];

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Schedule")}
        subtitle={t("schedule.subtitle")}
      />

      <Card>
        <PeriodStepper
          unit="week"
          variant="labeled"
          fill
          onPrev={() => setWeekStart(addDaysIso(weekStart, -7))}
          onNext={() => setWeekStart(addDaysIso(weekStart, 7))}
          onToday={() => setWeekStart(mondayOfIso(todayIso()))}
          todayLabel={t("schedule.thisWeek")}
        >
          <div className={styles.weekLabel}>
            {formatWeekRange(weekStart)}
          </div>
        </PeriodStepper>
      </Card>

      {activeRoster.length === 0 ? (
        <Card>
          <EmptyState
            title={t("schedule.noRoster")}
            body={t("schedule.noRosterBody")}
          />
        </Card>
      ) : shifts.isLoading ? (
        <Card><Loading /></Card>
      ) : shifts.isError && !shifts.data ? (
        // A failed load is not an empty week: an empty grid would
        // invite the admin to re-plan shifts that already exist.
        <ErrorState
          message={t("schedule.loadFailed")}
          onRetry={() => { void shifts.refetch(); }}
          busy={shifts.isFetching}
        />
      ) : (
        <div className={styles.weekGrid}>
          {Array.from({ length: 7 }, (_, i) => {
            const iso = addDaysIso(weekStart, i);
            return (
              <DayColumn
                key={iso}
                date={iso}
                shifts={shiftsByDay.get(iso) ?? []}
                roster={activeRoster}
                onSaved={(msg) => {
                  toast({ message: msg, tone: "success" });
                  refresh();
                }}
                onError={(msg) =>
                  toast({ message: msg, tone: "error" })}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}


function DayColumn({
  date, shifts, roster, onSaved, onError,
}: {
  /** YYYY-MM-DD. */
  date: string;
  shifts: ShiftRow[];
  roster: { id: number; name: string }[];
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const t = useT();
  const isToday = date === todayIso();
  return (
    <div className={`${styles.dayCol}${isToday ? " " + styles.dayColToday : ""}`}>
      <div className={styles.dayHeader}>
        <span className={styles.dayName}>
          {weekdayNamesShort()[weekdayOfIso(date)]}
        </span>
        <span className={styles.dayDate}>{Number(date.slice(8, 10))}</span>
      </div>
      <div className={styles.dayBody}>
        {shifts.length === 0 && !adding && (
          <div className={styles.empty}>{t("schedule.noShifts")}</div>
        )}
        {shifts.map((s) => (
          <ShiftCard
            key={s.id} shift={s} roster={roster}
            onSaved={onSaved} onError={onError}
          />
        ))}
        {adding ? (
          <ShiftForm
            defaultDate={date}
            roster={roster}
            onCancel={() => setAdding(false)}
            onSaved={(msg) => { setAdding(false); onSaved(msg); }}
            onError={onError}
          />
        ) : (
          <Button
            type="button" tone="secondary"
            onClick={() => setAdding(true)}
          >
            {t("schedule.addShift")}
          </Button>
        )}
      </div>
    </div>
  );
}


function ShiftCard({
  shift, roster, onSaved, onError,
}: {
  shift: ShiftRow;
  roster: { id: number; name: string }[];
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const t = useT();

  async function doDelete() {
    setBusy(true);
    try {
      await deleteShift(shift.id);
      onSaved(t("schedule.deleted", { name: shift.employee_name }));
      setConfirmingDelete(false);
    } catch (err) {
      onError(apiErrorMessage(err, t("schedule.deleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <ShiftForm
        existing={shift}
        defaultDate={shift.shift_date}
        roster={roster}
        onCancel={() => setEditing(false)}
        onSaved={(msg) => { setEditing(false); onSaved(msg); }}
        onError={onError}
      />
    );
  }
  return (
    <div className={styles.shift}>
      <div className={styles.shiftTimes}>
        {trimSeconds(shift.start_time)}–{trimSeconds(shift.end_time)}
      </div>
      <div className={styles.shiftWho}>{shift.employee_name}</div>
      {shift.notes && (
        <div className={styles.shiftNotes}>{shift.notes}</div>
      )}
      <div className={styles.shiftActions}>
        <button
          type="button" className={styles.linkBtn}
          onClick={() => setEditing(true)}
        >
          {t("common.edit")}
        </button>
        <button
          type="button" className={styles.linkBtn}
          onClick={() => setConfirmingDelete(true)}
          disabled={busy}
        >
          {busy ? "…" : t("payroll.delete")}
        </button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={t("schedule.deleteTitle")}
        message={t("schedule.deleteBody", {
          time: trimSeconds(shift.start_time), name: shift.employee_name,
        })}
        confirmLabel={t("payroll.delete")}
        confirmTone="danger"
        busy={busy}
        onConfirm={() => { void doDelete(); }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}


function ShiftForm({
  existing, defaultDate, roster, onCancel, onSaved, onError,
}: {
  existing?: ShiftRow;
  defaultDate: string;
  roster: { id: number; name: string }[];
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [empId, setEmpId] = useState<number | "">(
    existing?.store_employee_id ?? "",
  );
  const [startTime, setStartTime] = useState(
    existing ? trimSeconds(existing.start_time) : "09:00",
  );
  const [endTime, setEndTime] = useState(
    existing ? trimSeconds(existing.end_time) : "17:00",
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const t = useT();
  const { dirty } = useDirtyBaseline({ empId, startTime, endTime, notes });
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("schedule.unsavedMessage"),
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (empId === "") return;
    setBusy(true);
    try {
      if (existing) {
        const updated = await updateShift(existing.id, {
          store_employee_id: Number(empId),
          shift_date: defaultDate,
          start_time: startTime,
          end_time:   endTime,
          notes,
        });
        onSaved(t("schedule.updated", { name: updated.employee_name }));
      } else {
        const created = await createShift({
          store_employee_id: Number(empId),
          shift_date: defaultDate,
          start_time: startTime,
          end_time:   endTime,
          notes,
        });
        onSaved(t("schedule.scheduled", { name: created.employee_name }));
      }
    } catch (err) {
      onError(apiErrorMessage(err, t("schedule.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      <Field label={t("schedule.cashier")}>
        <Select
          value={empId === "" ? "" : String(empId)}
          onChange={(e) => {
            const v = e.target.value;
            setEmpId(v === "" ? "" : Number(v));
          }}
          required
        >
          <option value="">{t("schedule.pick")}</option>
          {roster.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </Select>
      </Field>
      <div className={styles.formTimeRow}>
        <Field label={t("schedule.start")}>
          <Input
            type="time" value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />
        </Field>
        <Field label={t("schedule.end")}>
          <Input
            type="time" value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label={t("schedule.notesOptional")}>
        <Input
          type="text" maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <FormActions guard={guard}>
        <Button
          type="button" tone="secondary"
          onClick={() => guard.confirmLeave(onCancel)} disabled={busy}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy} disabled={busy || empId === ""}>
          {existing ? t("payroll.save") : t("schedule.add")}
        </Button>
      </FormActions>
    </form>
  );
}


// The week maths (mondayOfIso / addDaysIso / formatWeekRange) lives
// in lib/datetime, shared with every other period page.

function trimSeconds(hms: string): string {
  // "09:00:00" → "09:00".  Backend returns HH:MM:SS from Python
  // ``time.isoformat()``; we display HH:MM only.
  return hms.length >= 5 ? hms.slice(0, 5) : hms;
}

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  adminCreateEntry, adminDeleteEntry, adminUpdateEntry,
  TIMECLOCK_STATUS_TONES, useAdminTimeClock, useTimeClockHistory,
  type TimeClockEntryRow, type TimeClockStatus,
} from "../api/timeclock";
import { useEmployees } from "../api/transfers";
import { updateStoreInfo, useStoreInfo } from "../api/account";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtHours } from "../lib/formatters";
import {
  daysAgoIso, formatDate, formatTimestamp, utcToZonedInput, zonedInputToUtcIso,
} from "../lib/datetime";
import {
  Alert, Button, Card, ConfirmDialog, DataTable, DateInput, EmptyState, ErrorState,
  Field, InfoTip, Input, KpiCard, KpiGrid,
  Loading, Modal, PageHeader, PageShell, Pill, RowActions, Select,
  TableSkeleton, Textarea, useToast, type DataColumn,
  Empty,
  ModalActions,
} from "../components/ui";
import { getCurrentIdentity } from "../lib/auth";
import styles from "./AdminTimeClock.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/admin/timeclock — payroll history view. Admins can:
//   • Filter by date window + roster member
//   • See split KPI tiles for Approved / Pending / Total hours
//   • Inspect entries grouped per roster member with a date-range
//     header (matches the inspiration screen)
//   • Back-fill shifts (cashier forgot to punch) via "+ New entry"
//   • Edit timestamps / notes / status on any existing entry
//   • Delete entries (audit chain survives)
//   • Inspect the per-entry audit chain (clock-in / -out /
//     admin_* rows, newest-first) via Logs
// Per-row actions go through the shared ``<RowActions>``
// primitive — inline buttons on desktop, bottom-sheet on
// narrow viewports. The status column flips between pending /
// approved / rejected pills; ``Adjusted: Yes`` lights up on
// any row an admin has touched after the fact.

type ModalState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; row: TimeClockEntryRow };

export default function AdminTimeClock() {
  const identity      = getCurrentIdentity();
  const queryClient   = useQueryClient();
  const roster        = useEmployees();
  const { data: storeInfo } = useStoreInfo();

  // Default window: today and the prior 13 days (a typical
  // biweekly pay period). ``to`` is half-open per the API.
  const [from, setFrom] = useState(() => daysAgoIso(13));
  const [to,   setTo]   = useState(() => daysAgoIso(-1));   // tomorrow
  const [empFilter, setEmpFilter] = useState<number | "">("");

  const [modal, setModal] = useState<ModalState>({ kind: "closed" });
  const [expandedHistoryId, setExpandedHistoryId] =
    useState<number | null>(null);
  // Pending entry-id staged for delete via the kit ConfirmDialog.
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const toast = useToast();

  const data = useAdminTimeClock(
    from, to, empFilter === "" ? undefined : Number(empFilter),
  );

  const canView = identity?.role === "admin"
                  || identity?.role === "owner"
                  || identity?.role === "superadmin";

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["timeclock"] });
  }

  // Group rows by store_employee_id so we can render an
  // inspiration-style section per roster member.
  const groups = useMemo(() => {
    const rows = data.data?.rows ?? [];
    const map = new Map<number, TimeClockEntryRow[]>();
    for (const r of rows) {
      const list = map.get(r.store_employee_id) ?? [];
      list.push(r);
      map.set(r.store_employee_id, list);
    }
    return Array.from(map.entries()).map(([sid, rows]) => ({
      storeEmployeeId: sid,
      employeeName: rows[0]?.employee_name ?? "",
      rows,
    }));
  }, [data.data]);

  if (!canView) {
    return (
      <PageShell>
        <PageHeader title="Payroll" />
        <EmptyState title="Admin or owner only." />
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title="Payroll"
        subtitle="Approved hours feed payroll; pending shifts are still waiting on admin review."
        actions={(
          <Button size="sm" onClick={() => setModal({ kind: "create" })}>
            + New entry
          </Button>
        )}
      />

      <KpiRow data={data.data} />

      <Card>
        <div className={styles.filterRow}>
          <Field label="From" style={{ minWidth: "10rem" }}>
            <DateInput
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To (exclusive)" style={{ minWidth: "10rem" }}>
            <DateInput
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label="Employee" style={{ minWidth: "12rem" }}>
            <Select
              value={empFilter === "" ? "" : String(empFilter)}
              onChange={(e) => {
                const v = e.target.value;
                setEmpFilter(v === "" ? "" : Number(v));
              }}
            >
              <option value="">Everyone</option>
              {(roster.data?.employees ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <LateThresholdSetting
        key={storeInfo?.store?.timeclock_late_minutes_threshold ?? 5}
        current={storeInfo?.store?.timeclock_late_minutes_threshold ?? 5}
      />

      {data.isLoading && (
        <Card><TableSkeleton rows={5} cols={6} /></Card>
      )}
      {data.isError && (
        <Card>
          <ErrorState
            message="Couldn't load payroll history."
            onRetry={() => { void data.refetch(); }}
          />
        </Card>
      )}
      {data.data && groups.length === 0 && !data.isLoading && (
        <Card>
          <EmptyState title="No shifts in this window." />
        </Card>
      )}
      {data.data && groups.map((g) => (
        <Card key={g.storeEmployeeId}>
          <EmployeeGroupHeader
            storeEmployeeId={g.storeEmployeeId}
            employeeName={g.employeeName}
            from={from} to={to}
            onOverview={() => setEmpFilter(g.storeEmployeeId)}
            isFiltered={empFilter === g.storeEmployeeId}
          />
          <DataTable
            columns={entryColumns({
              lateThreshold: data.data?.late_threshold_minutes ?? 5,
              expandedHistoryId,
              onEdit: (r) => setModal({ kind: "edit", row: r }),
              onToggleLogs: (r) => setExpandedHistoryId(
                expandedHistoryId === r.id ? null : r.id,
              ),
              onOverview: (r) => setEmpFilter(r.store_employee_id),
              onDelete: (r) => setPendingDelete(r.id),
            })}
            rows={g.rows}
            rowKey={(r) => r.id}
            expandedRow={(r) => (
              expandedHistoryId === r.id ? <HistoryPanel entryId={r.id} /> : null
            )}
            emptyTitle="No shifts in this window."
          />
        </Card>
      ))}

      {modal.kind !== "closed" && (
        <EntryModal
          state={modal}
          roster={roster.data?.employees ?? []}
          onClose={() => setModal({ kind: "closed" })}
          onSaved={() => {
            setModal({ kind: "closed" });
            refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this time-clock entry?"
        message={
          "Delete this time-clock entry?  The audit row survives, but "
          + "the entry disappears from the payroll roll-up."
        }
        confirmLabel="Delete"
        confirmTone="danger"
        busy={deleteBusy}
        onConfirm={async () => {
          if (pendingDelete == null) return;
          setDeleteBusy(true);
          try {
            await adminDeleteEntry(pendingDelete);
            setPendingDelete(null);
            refresh();
          } catch (e) {
            toast({
              message: apiErrorMessage(e, "Couldn't delete."),
              tone: "error",
              duration: 5000,
            });
          } finally {
            setDeleteBusy(false);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </PageShell>
  );
}


// ── Entry table ─────────────────────────────────────────────


/** One roster member's shifts as the kit ``<DataTable>``; "Logs"
 *  opens the entry's change history under its row. */
function entryColumns({
  lateThreshold, expandedHistoryId, onEdit, onToggleLogs, onOverview, onDelete,
}: {
  lateThreshold: number;
  expandedHistoryId: number | null;
  onEdit: (r: TimeClockEntryRow) => void;
  onToggleLogs: (r: TimeClockEntryRow) => void;
  onOverview: (r: TimeClockEntryRow) => void;
  onDelete: (r: TimeClockEntryRow) => void;
}): DataColumn<TimeClockEntryRow>[] {
  return [
    {
      key: "in", header: "Time in",
      render: (r) => <span className={styles.mono}>{formatTimestamp(r.clock_in_at)}</span>,
    },
    {
      key: "out", header: "Time out",
      render: (r) => (
        <span className={styles.mono}>
          {r.clock_out_at
            ? formatTimestamp(r.clock_out_at)
            : <em className={styles.openTag}>in progress</em>}
        </span>
      ),
    },
    {
      key: "hours", header: "Total hours",
      render: (r) => <span className={styles.totalCell}>{fmtHours(r.hours_worked)}</span>,
    },
    {
      key: "late", header: "Late",
      render: (r) => <LateBadge lateMinutes={r.late_minutes} threshold={lateThreshold} />,
    },
    { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
    { key: "adjusted", header: "Adjusted", render: (r) => <AdjustedBadge adjusted={r.adjusted} /> },
    {
      key: "actions", header: "", label: "",
      render: (r) => (
        <RowActions
          title={`${r.employee_name} · ${formatDate(r.clock_in_at)}`}
          actions={[
            {
              label: "Edit", tone: "warning",
              perm: "time_clock.update",
              onClick: () => onEdit(r),
            },
            {
              label: expandedHistoryId === r.id ? "Hide logs" : "Logs",
              tone: "logs",
              onClick: () => onToggleLogs(r),
            },
            {
              label: "Overview", tone: "info",
              onClick: () => onOverview(r),
            },
            {
              label: "Delete", tone: "danger",
              perm: "time_clock.update",
              onClick: () => onDelete(r),
            },
          ]}
        />
      ),
    },
  ];
}


// ── KPI tiles ───────────────────────────────────────────────


function KpiRow({
  data,
}: { data: { approved_hours: number; pending_hours: number; total_hours: number } | undefined }) {
  const approved = data?.approved_hours ?? 0;
  const pending  = data?.pending_hours ?? 0;
  const total    = data?.total_hours ?? 0;
  return (
    <KpiGrid minWidth="11rem">
      <KpiCard label="Approved hours" value={fmtHours(approved)}
        tone="positive" colorValue />
      <KpiCard label="Pending hours" value={fmtHours(pending)}
        tone="warning" colorValue />
      <KpiCard label="Total hours (window)" value={fmtHours(total)}
        tone="primary" colorValue />
    </KpiGrid>
  );
}


// ── Per-employee group header ───────────────────────────────


function EmployeeGroupHeader({
  storeEmployeeId, employeeName, from, to, onOverview, isFiltered,
}: {
  storeEmployeeId: number;
  employeeName:    string;
  from:            string;
  to:              string;
  onOverview:      () => void;
  isFiltered:      boolean;
}) {
  return (
    <div className={styles.groupHeader}>
      <div className={styles.groupName}>
        {employeeName.toUpperCase()}
        <span className={styles.groupRange}>
          {" — "}{from} to {to}
        </span>
      </div>
      <div className={styles.rowActions}>
        {!isFiltered && (
          <Button size="sm" tone="secondary" onClick={onOverview}>
            Overview only
          </Button>
        )}
        <Button
          size="sm" tone="secondary"
          onClick={() => {
            const url = `/app/admin/timeclock/paystub/${storeEmployeeId}`
              + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
            window.open(url, "_blank", "noopener");
          }}
        >
          Print paystub
        </Button>
      </div>
    </div>
  );
}


// ── Status + Adjusted badges ────────────────────────────────


function StatusPill({ status }: { status: TimeClockStatus }) {
  return <Pill tone={TIMECLOCK_STATUS_TONES[status]}>{status}</Pill>;
}


function AdjustedBadge({ adjusted }: { adjusted: boolean }) {
  if (adjusted) return <Pill tone="info">Yes</Pill>;
  return <span className={styles.subtle}>No</span>;
}


function LateBadge({
  lateMinutes, threshold,
}: { lateMinutes: number | null; threshold: number }) {
  // No planned shift to compare against — the entry was a back-fill
  // or an unscheduled punch.  Show "—" so the column reads cleanly.
  if (lateMinutes == null) {
    return <span className={styles.subtle}>—</span>;
  }
  // On time or early — a single muted glyph keeps the column quiet.
  if (lateMinutes <= threshold) {
    return <span className={styles.subtle}>On time</span>;
  }
  return <Pill tone="warning">{`Late ${lateMinutes}m`}</Pill>;
}


// Store-level payroll rule: how many minutes past a planned shift's
// start counts as "Late" for the pill above. Lives here (not in
// Settings) so the rule sits next to the column it drives. Persists
// via the store-info endpoint; remounts on the saved value (`key` at
// the call site) so it re-syncs after a refetch without an effect.
function LateThresholdSetting({ current }: { current: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [value, setValue] = useState(String(current));
  const [busy, setBusy] = useState(false);
  const dirty = value.trim() !== "" && Number(value) !== current;

  async function save() {
    const n = Math.max(0, Math.min(240, Math.round(Number(value) || 0)));
    setBusy(true);
    try {
      await updateStoreInfo({ timeclock_late_minutes_threshold: n });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["timeclock", "admin"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "store-info"] }),
      ]);
      toast({ message: `Late threshold set to ${n} min.`, tone: "success" });
    } catch (e) {
      toastApiError(e, "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.lateRuleRow}>
        <Field
          label={<>Mark clock-ins late after (minutes)<InfoTip text="Only clock-ins later than this past the planned shift start show the 'Late' pill below." /></>}
          hint="0–240"
        >
          <Input
            type="number" min="0" max="240" step="1"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ maxWidth: "8rem" }}
          />
        </Field>
        <Button
          tone="secondary" size="sm" busy={busy}
          disabled={busy || !dirty}
          onClick={() => { void save(); }}
        >
          Save
        </Button>
      </div>
    </Card>
  );
}


// ── History panel ───────────────────────────────────────────


function HistoryPanel({ entryId }: { entryId: number }) {
  const { data, isLoading, isError, refetch } =
    useTimeClockHistory(entryId);
  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <ErrorState
        message="Couldn't load entry history."
        onRetry={() => { void refetch(); }}
      />
    );
  }
  if (!data || data.rows.length === 0) {
    return <Empty>No history yet.</Empty>;
  }
  return (
    <ul className={styles.historyList}>
      {data.rows.map((h) => (
        <li key={h.id} className={styles.historyItem}>
          <div className={styles.historyHeader}>
            <span className={styles.historyAction}>{h.action}</span>
            <span>{formatTimestamp(h.at)}</span>
            <span className={styles.historyActor}>
              by {h.actor || "unknown"}{h.actor_role
                ? ` (${h.actor_role})` : ""}
            </span>
          </div>
          <div className={styles.historySummary}>{h.summary}</div>
        </li>
      ))}
    </ul>
  );
}


// ── Delete button ───────────────────────────────────────────


// ── Create / edit modal ─────────────────────────────────────


interface RosterMember { id: number; name: string }

function EntryModal({
  state, roster, onClose, onSaved,
}: {
  state: ModalState;
  roster: RosterMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = state.kind === "edit";
  const row    = state.kind === "edit" ? state.row : null;

  const [empId, setEmpId] = useState<number | "">(
    row ? row.store_employee_id : (roster[0]?.id ?? ""),
  );
  const [clockIn, setClockIn]   = useState(
    row ? utcToZonedInput(row.clock_in_at) : "",
  );
  const [clockOut, setClockOut] = useState(
    row && row.clock_out_at ? utcToZonedInput(row.clock_out_at) : "",
  );
  const [notes, setNotes]   = useState(row?.notes ?? "");
  const [status, setStatus] = useState<TimeClockStatus>(
    row?.status ?? "pending",
  );
  const [busy, setBusy]     = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      if (isEdit && row) {
        await adminUpdateEntry(row.id, {
          clock_in_at:  clockIn
            ? zonedInputToUtcIso(clockIn)
            : undefined,
          clock_out_at: clockOut
            ? zonedInputToUtcIso(clockOut)
            : null,
          notes,
          status,
        });
      } else {
        if (empId === "") {
          setErr("Pick a roster member.");
          setBusy(false); return;
        }
        await adminCreateEntry({
          store_employee_id: Number(empId),
          clock_in_at:  zonedInputToUtcIso(clockIn),
          clock_out_at: clockOut
            ? zonedInputToUtcIso(clockOut)
            : null,
          notes,
        });
      }
      onSaved();
    } catch (e2) {
      setErr(
        apiErrorMessage(e2, "Couldn't save the entry."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={isEdit ? "Edit entry" : "New entry"}
      disabled={busy}
    >
      <form onSubmit={onSubmit}>
        <div className={styles.modalGrid}>
          <Field label="Roster name" style={{ gridColumn: "1 / -1" }}>
            <Select
              value={empId === "" ? "" : String(empId)}
              onChange={(e) => {
                const v = e.target.value;
                setEmpId(v === "" ? "" : Number(v));
              }}
              required
              disabled={isEdit}   // can't reattribute on edit
            >
              <option value="">— pick a roster member —</option>
              {roster.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Clock in">
            <Input
              type="datetime-local" required
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </Field>
          <Field
            label="Clock out (optional)"
            hint="Leave blank for an open / in-progress entry."
          >
            <Input
              type="datetime-local"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
            />
          </Field>
          {isEdit && (
            <Field
              label={<>Status<InfoTip text="Only approved hours count toward payroll totals." /></>}
              style={{ gridColumn: "1 / -1" }}
            >
              <Select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as TimeClockStatus)}
              >
                <option value="pending">pending</option>
                <option value="approved">approved</option>
                <option value="rejected">rejected</option>
              </Select>
            </Field>
          )}
          <Field label="Notes" style={{ gridColumn: "1 / -1" }}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Why this entry was back-filled / edited."
            />
          </Field>
        </div>
        {err && <Alert tone="error">{err}</Alert>}
        <ModalActions>
          <Button
            type="button" tone="secondary"
            onClick={onClose} disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            {isEdit ? "Save changes" : "Create entry"}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}


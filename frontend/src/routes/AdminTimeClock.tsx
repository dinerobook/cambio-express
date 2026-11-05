import { Fragment, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  adminCreateEntry, adminDeleteEntry, adminUpdateEntry,
  TIMECLOCK_STATUS_TONES, timeClockStatusLabel, useAdminTimeClock, useTimeClockHistory,
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
  Alert, Button, Card, ConfirmDialog, DateInput, EmptyState, ErrorState,
  Field, InfoTip, Input, KpiCard, KpiGrid,
  Loading, Modal, PageHeader, PageShell, Pill, RowActions, Select, Table,
  TableSkeleton, Textarea, tdStyle, thStyle, useToast,
  Empty,
  ModalActions,
} from "../components/ui";
import { getCurrentIdentity } from "../lib/auth";
import styles from "./AdminTimeClock.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { roleLabel } from "../api/roles";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

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
  const t = useT();

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
        <PageHeader title={navWord("Payroll")} />
        <EmptyState title={t("payroll.adminOnly")} />
      </PageShell>
    );
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Payroll")}
        subtitle={t("payroll.subtitle")}
        actions={(
          <Button size="sm" onClick={() => setModal({ kind: "create" })}>
            {t("payroll.newEntry")}
          </Button>
        )}
      />

      <KpiRow data={data.data} />

      <Card>
        <div className={styles.filterRow}>
          <Field label={t("payroll.from")} style={{ minWidth: "10rem" }}>
            <DateInput
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t("payroll.toExclusive")} style={{ minWidth: "10rem" }}>
            <DateInput
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label={t("payroll.employee")} style={{ minWidth: "12rem" }}>
            <Select
              value={empFilter === "" ? "" : String(empFilter)}
              onChange={(e) => {
                const v = e.target.value;
                setEmpFilter(v === "" ? "" : Number(v));
              }}
            >
              <option value="">{t("payroll.everyone")}</option>
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
            message={t("payroll.loadFailed")}
            onRetry={() => { void data.refetch(); }}
          />
        </Card>
      )}
      {data.data && groups.length === 0 && !data.isLoading && (
        <Card>
          <EmptyState title={t("payroll.noShifts")} />
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
          <Table>
            <thead>
              <tr>
                {[
                  t("payroll.timeIn"), t("payroll.timeOut"), t("payroll.totalHours"),
                  t("payroll.late"), t("common.status"), t("payroll.adjusted"), "",
                ].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td style={tdStyle}>
                      <span className={styles.mono}>
                        {formatTimestamp(r.clock_in_at)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span className={styles.mono}>
                        {r.clock_out_at
                          ? formatTimestamp(r.clock_out_at)
                          : <em className={styles.openTag}>{t("payroll.inProgress")}</em>}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span className={styles.totalCell}>
                        {fmtHours(r.hours_worked)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <LateBadge
                        lateMinutes={r.late_minutes}
                        threshold={data.data?.late_threshold_minutes ?? 5}
                      />
                    </td>
                    <td style={tdStyle}>
                      <StatusPill status={r.status} />
                    </td>
                    <td style={tdStyle}>
                      <AdjustedBadge adjusted={r.adjusted} />
                    </td>
                    <td style={tdStyle}>
                      <RowActions
                        title={`${r.employee_name} · ${formatDate(r.clock_in_at)}`}
                        actions={[
                          {
                            label: t("common.edit"), tone: "warning",
                            perm: "time_clock.update",
                            onClick: () => setModal({ kind: "edit", row: r }),
                          },
                          {
                            label: expandedHistoryId === r.id ? t("payroll.hideLogs") : t("payroll.logs"),
                            tone: "logs",
                            onClick: () => setExpandedHistoryId(
                              expandedHistoryId === r.id ? null : r.id,
                            ),
                          },
                          {
                            label: t("payroll.overview"), tone: "info",
                            onClick: () => setEmpFilter(r.store_employee_id),
                          },
                          {
                            label: t("payroll.delete"), tone: "danger",
                            perm: "time_clock.update",
                            onClick: () => setPendingDelete(r.id),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                  {expandedHistoryId === r.id && (
                    <tr className={styles.historyRow}>
                      <td colSpan={7} style={tdStyle}>
                        <HistoryPanel entryId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
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
        title={t("payroll.deleteTitle")}
        message={t("payroll.deleteBody")}
        confirmLabel={t("payroll.delete")}
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
              message: apiErrorMessage(e, t("payroll.deleteFailed")),
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


// ── KPI tiles ───────────────────────────────────────────────


function KpiRow({
  data,
}: { data: { approved_hours: number; pending_hours: number; total_hours: number } | undefined }) {
  const approved = data?.approved_hours ?? 0;
  const pending  = data?.pending_hours ?? 0;
  const total    = data?.total_hours ?? 0;
  const t = useT();
  return (
    <KpiGrid minWidth="11rem">
      <KpiCard label={t("payroll.approvedHours")} value={fmtHours(approved)}
        tone="positive" colorValue />
      <KpiCard label={t("payroll.pendingHours")} value={fmtHours(pending)}
        tone="warning" colorValue />
      <KpiCard label={t("payroll.windowHours")} value={fmtHours(total)}
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
  const t = useT();
  return (
    <div className={styles.groupHeader}>
      <div className={styles.groupName}>
        {employeeName.toUpperCase()}
        <span className={styles.groupRange}>
          {" — "}{t("payroll.range", { from: formatDate(from), to: formatDate(to) })}
        </span>
      </div>
      <div className={styles.rowActions}>
        {!isFiltered && (
          <Button size="sm" tone="secondary" onClick={onOverview}>
            {t("payroll.overviewOnly")}
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
          {t("payroll.printPaystub")}
        </Button>
      </div>
    </div>
  );
}


// ── Status + Adjusted badges ────────────────────────────────


function StatusPill({ status }: { status: TimeClockStatus }) {
  useT();
  return <Pill tone={TIMECLOCK_STATUS_TONES[status]}>{timeClockStatusLabel(status)}</Pill>;
}


function AdjustedBadge({ adjusted }: { adjusted: boolean }) {
  const t = useT();
  if (adjusted) return <Pill tone="info">{t("payroll.yes")}</Pill>;
  return <span className={styles.subtle}>{t("payroll.no")}</span>;
}


function LateBadge({
  lateMinutes, threshold,
}: { lateMinutes: number | null; threshold: number }) {
  const t = useT();
  // No planned shift to compare against — the entry was a back-fill
  // or an unscheduled punch.  Show "—" so the column reads cleanly.
  if (lateMinutes == null) {
    return <span className={styles.subtle}>—</span>;
  }
  // On time or early — a single muted glyph keeps the column quiet.
  if (lateMinutes <= threshold) {
    return <span className={styles.subtle}>{t("payroll.onTime")}</span>;
  }
  return <Pill tone="warning">{t("payroll.lateBy", { minutes: lateMinutes })}</Pill>;
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
  const t = useT();
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
      toast({ message: t("payroll.lateSet", { minutes: n }), tone: "success" });
    } catch (e) {
      toastApiError(e, t("payroll.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.lateRuleRow}>
        <Field
          label={<>{t("payroll.lateLabel")}<InfoTip text={t("payroll.lateTip")} /></>}
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
          {t("payroll.save")}
        </Button>
      </div>
    </Card>
  );
}


// ── History panel ───────────────────────────────────────────


function HistoryPanel({ entryId }: { entryId: number }) {
  const { data, isLoading, isError, refetch } =
    useTimeClockHistory(entryId);
  const t = useT();
  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <ErrorState
        message={t("payroll.historyFailed")}
        onRetry={() => { void refetch(); }}
      />
    );
  }
  if (!data || data.rows.length === 0) {
    return <Empty>{t("payroll.noHistory")}</Empty>;
  }
  return (
    <ul className={styles.historyList}>
      {data.rows.map((h) => (
        <li key={h.id} className={styles.historyItem}>
          <div className={styles.historyHeader}>
            <span className={styles.historyAction}>{h.action}</span>
            <span>{formatTimestamp(h.at)}</span>
            <span className={styles.historyActor}>
              {h.actor_role
                ? t("payroll.byRole", { actor: h.actor || t("payroll.unknown"), role: roleLabel(h.actor_role) })
                : t("payroll.by", { actor: h.actor || t("payroll.unknown") })}
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
  const t = useT();
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
          setErr(t("payroll.pickMember"));
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
        apiErrorMessage(e2, t("payroll.entrySaveFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={isEdit ? t("payroll.editEntry") : t("payroll.newEntryTitle")}
      disabled={busy}
    >
      <form onSubmit={onSubmit}>
        <div className={styles.modalGrid}>
          <Field label={t("payroll.rosterName")} style={{ gridColumn: "1 / -1" }}>
            <Select
              value={empId === "" ? "" : String(empId)}
              onChange={(e) => {
                const v = e.target.value;
                setEmpId(v === "" ? "" : Number(v));
              }}
              required
              disabled={isEdit}   // can't reattribute on edit
            >
              <option value="">{t("payroll.pickPlaceholder")}</option>
              {roster.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("payroll.clockIn")}>
            <Input
              type="datetime-local" required
              value={clockIn}
              onChange={(e) => setClockIn(e.target.value)}
            />
          </Field>
          <Field
            label={t("payroll.clockOut")}
            hint={t("payroll.clockOutHint")}
          >
            <Input
              type="datetime-local"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
            />
          </Field>
          {isEdit && (
            <Field
              label={<>{t("common.status")}<InfoTip text={t("payroll.statusTip")} /></>}
              style={{ gridColumn: "1 / -1" }}
            >
              <Select
                value={status}
                onChange={(e) =>
                  setStatus(e.target.value as TimeClockStatus)}
              >
                <option value="pending">{timeClockStatusLabel("pending")}</option>
                <option value="approved">{timeClockStatusLabel("approved")}</option>
                <option value="rejected">{timeClockStatusLabel("rejected")}</option>
              </Select>
            </Field>
          )}
          <Field label={t("payroll.notes")} style={{ gridColumn: "1 / -1" }}>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={t("payroll.notesPlaceholder")}
            />
          </Field>
        </div>
        {err && <Alert tone="error">{err}</Alert>}
        <ModalActions>
          <Button
            type="button" tone="secondary"
            onClick={onClose} disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            {isEdit ? t("common.saveChanges") : t("payroll.createEntry")}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}


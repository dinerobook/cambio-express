import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  fetchPunchChallenge,
  useClockInMutation, useClockOutMutation,
  useStartBreakMutation, useStopBreakMutation,
  useTimeClockStatus,
  type PunchInput, type TimeClockEntryRow,
} from "../api/timeclock";
import { useEmployees } from "../api/transfers";
import { useStoreInfo } from "../api/account";
import { apiErrorMessage } from "../lib/api";
import { formatTimestamp } from "../lib/datetime";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { getCurrentCoordinates } from "../lib/geolocation";
import { passkeysSupported, performPasskeyAssert } from "../lib/webauthn";
import {
  Button, Card, EmptyState, Empty, ErrorState, Field, InfoTip, Input,
  Loading, PageHeader, PageShell, Select, Table, tdStyle, thStyle,
  useToast,
} from "../components/ui";
import styles from "./TimeClock.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// A URL, the same in every language.
const SETTINGS_PATH = "/app/settings";

// /app/timeclock — employee punch page. Pick your roster name,
// clock in / out. The "who's currently clocked in?" panel below
// reflects every open entry at the store so a cashier can see if
// their name is already punched (e.g. by a different terminal).

export default function TimeClock() {
  const queryClient   = useQueryClient();
  const roster        = useEmployees();
  const status        = useTimeClockStatus();
  const { data: storeInfo } = useStoreInfo();
  const clockIn   = useClockInMutation();
  const clockOut  = useClockOutMutation();
  const startBrk  = useStartBreakMutation();
  const stopBrk   = useStopBreakMutation();

  const [pickedEmpId, setPickedEmpId] = useState<number | "">("");
  const [notes, setNotes]             = useState("");
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const t = useT();

  const openByEmp = useMemo(() => {
    const map = new Map<number, TimeClockEntryRow>();
    for (const r of status.data?.open_entries ?? []) {
      map.set(r.store_employee_id, r);
    }
    return map;
  }, [status.data]);

  const pickedEntry = pickedEmpId !== ""
    ? openByEmp.get(Number(pickedEmpId)) ?? null
    : null;
  const pickedIsOpen   = pickedEntry !== null;
  const pickedOnBreak  = pickedEntry?.break_started_at != null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["timeclock", "status"] });
  }

  // True when the store has flipped on the passkey gate.
  // Determines whether the punch flow runs the extra WebAuthn
  // round-trip before hitting clock-in / clock-out.
  const passkeyRequired =
    Boolean(storeInfo?.store?.timeclock_require_passkey);
  const geofenceRequired =
    Boolean(storeInfo?.store?.timeclock_require_geofence);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (pickedEmpId === "") return;
    const empId = Number(pickedEmpId);
    const empName =
      roster.data?.employees.find((m) => m.id === empId)?.name
        ?? t("clock.rosterNumber", { id: empId });
    try {
      // Optional WebAuthn pre-step. When the store requires a
      // passkey, fetch a challenge → run the OS prompt → echo
      // the assertion back on the punch call. Skipped entirely
      // when the toggle is off so the existing punch flow keeps
      // its zero-prompt UX.
      const punch: PunchInput = {
        store_employee_id: empId, notes,
      };
      if (passkeyRequired) {
        if (!passkeysSupported()) {
          throw new Error(t("clock.noWebauthn"));
        }
        const challenge = await fetchPunchChallenge(empId);
        const assertion = await performPasskeyAssert(
          challenge.options_json,
        );
        punch.assert_token = challenge.assert_token;
        punch.assertion    = assertion;
      }
      if (geofenceRequired) {
        // Browser GPS prompt — throws GeolocationDeniedError if
        // the user blocks it. The error message bubbles up to
        // the flash banner via the catch below.
        const coords = await getCurrentCoordinates();
        punch.geo_lat = coords.lat;
        punch.geo_lng = coords.lng;
      }
      if (pickedIsOpen) {
        await clockOut.mutateAsync(punch);
        toast({ message: t("clock.clockedOut", { name: empName }), tone: "success" });
      } else {
        await clockIn.mutateAsync(punch);
        toast({ message: t("clock.clockedIn", { name: empName }), tone: "success" });
      }
      setNotes("");
      refresh();
    } catch (err) {
      toast({
        message: apiErrorMessage(err, t("clock.punchFailed"), { anyError: true }),
        tone: "error",
      });
    }
  }

  if (roster.isError) {
    return (
      <PageShell maxWidth="56rem">
        <PageHeader title={navWord("Time clock")} />
        <ErrorState
          message={t("schedule.rosterFailed")}
          onRetry={() => { void roster.refetch(); }}
        />
      </PageShell>
    );
  }

  if (roster.isLoading) {
    return (
      <PageShell maxWidth="56rem">
        <PageHeader title={navWord("Time clock")} />
        <Loading />
      </PageShell>
    );
  }

  // ``useEmployees`` already filters to active-only server-side.
  const activeRoster = roster.data?.employees ?? [];

  return (
    <PageShell maxWidth="56rem">

      <PageCrumbs />

      <PageHeader
        title={navWord("Time clock")}
        subtitle={t("clock.subtitle")}
      />

      {activeRoster.length === 0 && (
        <Empty>
          {tNodes("clock.noRoster", { path: <code>{SETTINGS_PATH}</code> })}
        </Empty>
      )}

      {activeRoster.length > 0 && (
        <Card>
          <form onSubmit={onSubmit} className={styles.form}>
            <Field label={t("payroll.rosterName")}>
              <Select
                value={pickedEmpId === "" ? "" : String(pickedEmpId)}
                onChange={(e) => {
                  const v = e.target.value;
                  setPickedEmpId(v === "" ? "" : Number(v));
                }}
                required
              >
                <option value="">{t("clock.pickName")}</option>
                {activeRoster.map((m) => {
                  const open = openByEmp.get(m.id);
                  return (
                    <option key={m.id} value={m.id}>
                      {m.name}{open ? (
                        open.break_started_at
                          ? `  ${t("clock.onBreak")}`
                          : `  ${t("clock.clockedInTag")}`
                      ) : ""}
                    </option>
                  );
                })}
              </Select>
            </Field>
            <Field
              label={<>{t("schedule.notesOptional")}<InfoTip text={t("clock.notesTip")} /></>}
            >
              <Input
                type="text" maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            <div className={styles.actions}>
              {pickedIsOpen && (
                <Button
                  type="button"
                  tone="secondary"
                  busy={startBrk.isPending || stopBrk.isPending}
                  disabled={
                    pickedEmpId === ""
                    || startBrk.isPending
                    || stopBrk.isPending
                  }
                  onClick={async () => {
                    if (pickedEmpId === "") return;
                    const empId = Number(pickedEmpId);
                    try {
                      if (pickedOnBreak) {
                        await stopBrk.mutateAsync({
                          store_employee_id: empId,
                        });
                        toast({ message: t("clock.backFromBreak"), tone: "success" });
                      } else {
                        await startBrk.mutateAsync({
                          store_employee_id: empId,
                        });
                        toast({ message: t("clock.breakStarted"), tone: "success" });
                      }
                      refresh();
                    } catch (err) {
                      toastApiError(err, t("clock.breakFailed"));
                    }
                  }}
                >
                  {pickedOnBreak ? t("clock.endBreak") : t("clock.startBreak")}
                </Button>
              )}
              <Button
                type="submit"
                tone={pickedIsOpen ? "secondary" : "primary"}
                busy={clockIn.isPending || clockOut.isPending}
                disabled={
                  pickedEmpId === ""
                  || clockIn.isPending
                  || clockOut.isPending
                }
              >
                {pickedIsOpen ? t("clock.clockOut") : t("clock.clockIn")}
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card>
        <h2 className={styles.panelTitle}>{t("clock.current")}</h2>
        {status.isLoading && <Loading />}
        {status.isError && (
          <ErrorState
            message={t("clock.currentFailed")}
            onRetry={() => { void status.refetch(); }}
          />
        )}
        {status.data && status.data.open_entries.length === 0 && (
          <EmptyState title={t("clock.nobody")} />
        )}
        {status.data && status.data.open_entries.length > 0 && (
          <Table>
            <thead>
              <tr>
                {[t("payroll.rosterName"), t("clock.clockedInCol"), t("payroll.notes")].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.data.open_entries.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}>{r.employee_name}</td>
                  <td style={tdStyle}>
                    <span className={styles.mono}>
                      {formatTimestamp(r.clock_in_at)}
                    </span>
                  </td>
                  <td style={tdStyle}>{r.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </PageShell>
  );
}

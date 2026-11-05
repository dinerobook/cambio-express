import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  adminDeleteCredential,
  adminRegisterCredentialBegin,
  adminRegisterCredentialFinish,
  timeClockStatusLabel,
  useTimeClockCredentials,
  type TimeClockCredentialRow,
} from "../api/timeclock";
import { useStoreInfo } from "../api/account";
import { apiErrorMessage } from "../lib/api";
import { passkeysSupported, performPasskeyRegister } from "../lib/webauthn";
import {
  Alert, Card, ConfirmDialog, EmptyState, ErrorState, Loading,
  PageHeader, PageShell, Pill, RowActions, Table, tdStyle, thStyle,
} from "../components/ui";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import styles from "./AdminTimeClockCredentials.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/admin/timeclock/credentials — admin enrolls a passkey
// for each active roster member. Once every cashier is registered
// the admin flips the ``timeclock_require_passkey`` toggle on
// Settings → Store, after which clock-in / clock-out demand a
// fresh OS-level authentication (Windows Hello / Touch ID /
// Face ID / hardware key).

export default function AdminTimeClockCredentials() {
  const identity = getCurrentIdentity();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useTimeClockCredentials();
  const { data: storeInfo } = useStoreInfo();
  const [busyEmpId, setBusyEmpId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();

  const canView = identity?.role === "admin"
                  || identity?.role === "owner"
                  || identity?.role === "superadmin";
  const browserSupports = passkeysSupported();
  const gateOn = Boolean(storeInfo?.store?.timeclock_require_passkey);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["timeclock", "credentials"] });
  }

  async function register(row: TimeClockCredentialRow) {
    setErr(null); setBusyEmpId(row.store_employee_id);
    try {
      const begin = await adminRegisterCredentialBegin(
        row.store_employee_id,
      );
      const credential = await performPasskeyRegister(begin.options_json);
      await adminRegisterCredentialFinish(row.store_employee_id, {
        register_token: begin.register_token,
        credential,
        name: row.employee_name,
      });
      refresh();
    } catch (e) {
      setErr(
        apiErrorMessage(e, t("punch.registerFailed"), { anyError: true }),
      );
    } finally {
      setBusyEmpId(null);
    }
  }

  // Pending credential staged for removal; null = no confirm
  // showing.  Held as the whole row so the dialog can show the
  // employee name + the action handler has the employee id.
  const [pendingRemove, setPendingRemove] =
    useState<TimeClockCredentialRow | null>(null);

  async function doRemove() {
    if (!pendingRemove) return;
    setErr(null); setBusyEmpId(pendingRemove.store_employee_id);
    try {
      await adminDeleteCredential(pendingRemove.store_employee_id);
      refresh();
      setPendingRemove(null);
    } catch (e) {
      setErr(
        apiErrorMessage(e, t("punch.removeFailed")),
      );
    } finally {
      setBusyEmpId(null);
    }
  }

  if (!canView) {
    return (
      <PageShell maxWidth="56rem">
        <PageHeader title={navWord("Punch credentials")} />
        <EmptyState title={t("payroll.adminOnly")} />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="56rem">

      <PageCrumbs />

      <PageHeader
        title={navWord("Punch credentials")}
        subtitle={t("punch.subtitle")}
      />

      {!browserSupports && (
        <Alert tone="warning">
          {t("punch.noWebauthn")}
        </Alert>
      )}

      {gateOn && (
        <Alert tone="info">
          {tNodes("punch.gateOn", {
            on: <strong>{t("punch.on")}</strong>,
            registered: <em>{t("punch.registered")}</em>,
          })}
        </Alert>
      )}

      {!gateOn && (
        <p className={styles.intro}>
          {tNodes("punch.gateOff", { off: <strong>{t("punch.off")}</strong> })}
        </p>
      )}

      {isLoading && (
        <Card>
          <Loading />
        </Card>
      )}
      {isError && (
        <Card>
          <ErrorState
            message={t("punch.loadFailed")}
            onRetry={() => { void refetch(); }}
          />
        </Card>
      )}
      {data && data.rows.length === 0 && !isLoading && (
        <Card>
          <EmptyState
            title={t("punch.noRoster")}
            body={t("punch.noRosterBody")}
          />
        </Card>
      )}
      {data && data.rows.length > 0 && (
        <Card>
          <Table>
            <thead>
              <tr>
                {[
                  t("schedule.cashier"), t("common.status"), t("punch.registered"),
                  t("punch.lastUsed"), "",
                ].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.store_employee_id}>
                  <td style={tdStyle}>
                    <strong>{r.employee_name}</strong>
                  </td>
                  <td style={tdStyle}>
                    {r.has_passkey
                      ? <Pill tone="success">{t("punch.registered")}</Pill>
                      : <Pill tone="warning">{timeClockStatusLabel("pending")}</Pill>}
                  </td>
                  <td style={tdStyle}>
                    <span className={styles.mono}>
                      {r.registered_at
                        ? formatDate(r.registered_at)
                        : "—"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span className={styles.mono}>
                      {r.last_used_at
                        ? formatDate(r.last_used_at)
                        : "—"}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <RowActions
                      title={r.employee_name}
                      actions={[
                        {
                          label: r.has_passkey ? t("punch.reenroll") : t("punch.enroll"),
                          tone: r.has_passkey ? "secondary" : "primary",
                          busy: busyEmpId === r.store_employee_id,
                          disabled: !browserSupports || busyEmpId !== null,
                          onClick: () => register(r),
                        },
                        {
                          label: t("punch.remove"),
                          hidden: !r.has_passkey,
                          disabled: busyEmpId !== null,
                          onClick: () => setPendingRemove(r),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {err && <Alert tone="error">{err}</Alert>}

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("punch.removeTitle")}
        message={t("punch.removeBody", {
          name: pendingRemove?.employee_name ?? t("punch.thisCashier"),
        })}
        confirmLabel={t("punch.remove")}
        confirmTone="danger"
        busy={busyEmpId === pendingRemove?.store_employee_id}
        onConfirm={() => { void doRemove(); }}
        onCancel={() => setPendingRemove(null)}
      />
    </PageShell>
  );
}

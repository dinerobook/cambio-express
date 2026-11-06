import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  generateOwnerConnectCode, revokeOwnerConnectCode, useOwnerConnectCodes,
  type OwnerConnectCodeRow,
} from "../api/owner";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { AppLink,
  Alert, Button, Card, ConfirmDialog, CopyField, ErrorState, Loading, PageHeader, PageShell,
  Section, DataTable,
  Empty, type DataColumn,
} from "../components/ui";
import styles from "./OwnerConnect.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/owner/connect — owner mints 8-character invite codes that
// store admins redeem on their settings page to link a store to
// the owner's umbrella. v1 ships:
//   - one-active-code semantics: generating revokes the current
//     active code first, mirroring the legacy Flask behavior
//   - copy-to-clipboard for the active code
//   - revoke action for the active code
//   - last-10 redeemed history
//
// The 7-day TTL is enforced server-side; we just render
// `expires_at`. Backed by /api/v2/owner/connect-codes.

export default function OwnerConnect() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useOwnerConnectCodes();

  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // Two destructive actions live on this page; each gets its own
  // ConfirmDialog open-state so the right copy lands in the right
  // prompt.  Lifted above the role-check early-return so hooks
  // run in the same order on every render.
  const [confirmingGenerate, setConfirmingGenerate] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  // The legacy page shows the FIRST unused-unrevoked-unexpired
  // code as the "active" one; we narrow to the same shape.
  const active = useMemo<OwnerConnectCodeRow | null>(() => {
    if (!data) return null;
    return data.rows.find(
      (r) => !r.is_redeemed && !r.is_revoked && !r.is_expired,
    ) ?? null;
  }, [data]);

  const redeemed = useMemo<OwnerConnectCodeRow[]>(() => {
    if (!data) return [];
    return data.rows.filter((r) => r.is_redeemed).slice(0, 10);
  }, [data]);

  if (identity?.role !== "owner") {
    return (
      <PageShell maxWidth="40rem">
        <PageHeader title={navWord("Connect a store")} />
        <p className={styles.deny}>{t("connect.ownersOnly")}</p>
      </PageShell>
    );
  }

  async function doGenerate() {
    setConfirmingGenerate(false);
    setBusy(true); setServerError(null);
    try {
      // Legacy contract: generating revokes any active code first.
      // The new endpoint does NOT auto-revoke (clean separation),
      // so we revoke client-side before minting.
      if (active) {
        await revokeOwnerConnectCode(active.id);
      }
      await generateOwnerConnectCode();
      queryClient.invalidateQueries({ queryKey: ["owner", "connect-codes"] });
    } catch (err) {
      setServerError(
        apiErrorMessage(err, t("connect.generateFailed")),
      );
    } finally { setBusy(false); }
  }

  async function doRevoke() {
    if (!active) return;
    setConfirmingRevoke(false);
    setBusy(true); setServerError(null);
    try {
      await revokeOwnerConnectCode(active.id);
      queryClient.invalidateQueries({ queryKey: ["owner", "connect-codes"] });
    } catch (err) {
      setServerError(
        apiErrorMessage(err, t("connect.revokeFailed")),
      );
    } finally { setBusy(false); }
  }

  return (
    <PageShell maxWidth="40rem">

      <PageCrumbs />

      <PageHeader title={navWord("Connect a store")} />

      {serverError && <Alert tone="error">{serverError}</Alert>}

      <Section title={t("connect.activeCode")}>
        <Card>
          {isLoading && <Loading />}
          {isError && (
            <ErrorState
              message={t("connect.loadFailed", { error: apiErrorMessage(error, "") }).trimEnd()}
              onRetry={() => { void refetch(); }}
            />
          )}
          {!isLoading && !isError && !active && (
            <>
              <p className={styles.lead}>{t("connect.noActive")}</p>
              <Button onClick={() => setConfirmingGenerate(true)} busy={busy} disabled={busy}>
                {busy ? t("connect.generating") : t("connect.generate")}
              </Button>
            </>
          )}
          {active && (
            <>
              <p className={styles.lead}>
                {tNodes("connect.share", {
                  date: <strong>{formatDate(active.expires_at)}</strong>,
                })}
              </p>
              <CopyField
                className={styles.codeRow}
                variant="code"
                aria-label={t("connect.codeAria")}
                value={active.code}
              />
              <div className={styles.actionsRow}>
                <Button tone="secondary" onClick={() => setConfirmingRevoke(true)} disabled={busy}>
                  {t("connect.revoke")}
                </Button>
                <Button tone="secondary" onClick={() => setConfirmingGenerate(true)} disabled={busy}>
                  {busy ? t("connect.generating") : t("connect.generateNew")}
                </Button>
              </div>
            </>
          )}
        </Card>
      </Section>

      <Section
        title={t("connect.recentlyRedeemed")}
        actions={<span className={styles.mutedSm}>{t("connect.last10")}</span>}
      >
        <Card>
          {redeemed.length > 0 ? (
            <DataTable
              columns={redeemedColumns()}
              rows={redeemed}
              rowKey={(r) => r.id}
              emptyTitle={t("connect.noneRedeemedShort")}
            />
          ) : (
            <Empty>{t("connect.noneRedeemed")}</Empty>
          )}
        </Card>
      </Section>

      <p className={styles.fine}>
        {tNodes("connect.disconnect", {
          dashboard: (
            <AppLink fallback="text" to="/dashboard" className={styles.inlineLink}>
              {navWord("Dashboard")}
            </AppLink>
          ),
          locations: (
            <AppLink fallback="text" to="/owner/locations" className={styles.inlineLink}>
              {navWord("Locations")}
            </AppLink>
          ),
        })}
      </p>

      <ConfirmDialog
        open={confirmingGenerate}
        title={active ? t("connect.replaceTitle") : t("connect.generateTitle")}
        message={active ? t("connect.replaceBody") : t("connect.generateBody")}
        confirmLabel={active ? t("connect.replace") : t("connect.generateShort")}
        confirmTone={active ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => { void doGenerate(); }}
        onCancel={() => setConfirmingGenerate(false)}
      />
      <ConfirmDialog
        open={confirmingRevoke}
        title={t("connect.revokeTitle")}
        message={t("connect.revokeBody")}
        confirmLabel={t("connect.revoke")}
        confirmTone="danger"
        busy={busy}
        onConfirm={() => { void doRevoke(); }}
        onCancel={() => setConfirmingRevoke(false)}
      />
    </PageShell>
  );
}


// Built during render so the headings follow a language switch.
const redeemedColumns = (): DataColumn<OwnerConnectCodeRow>[] => [
  { key: "code", header: t("connect.colCode"), render: (r) => <span className={styles.mono}>{r.code}</span> },
  { key: "store", header: t("connect.colStore"), render: (r) => r.used_by_store_name || "—" },
  {
    key: "redeemed", header: t("connect.colRedeemed"),
    render: (r) => <span className={styles.cellMuted}>{formatDate(r.used_at)}</span>,
  },
];

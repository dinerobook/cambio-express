import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  revokeOtherSessions,
  revokeSession,
  useActiveSessions,
  type ActiveSessionRow,
} from "../api/account";
import { apiErrorMessage } from "../lib/api";
import {
  Alert, Button, Card, ConfirmDialog, ErrorState, InfoTip, Loading,
  PageHeader, PageShell, Section, space, Table, tdStyle, thStyle, tokens,
  useToast,
} from "../components/ui";
import styles from "./AccountSessions.module.css";
import { formatDate, formatShortDate, parseTimestamp } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/account/sessions — every browser the current user is signed
// in on. Backed by the refresh-token chain: one row per
// ``session_id`` (stable across rotation). The current session is
// flagged via the JWT's ``sid`` claim and rendered as
// non-revocable from the UI (the API still allows it, but
// dropping yourself out of your own page is bad UX).

export default function AccountSessions() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useActiveSessions();
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const toast = useToast();
  useT(); // re-render on a language switch

  async function onRevoke(sessionId: string) {
    setBusy(sessionId);
    setRevokeError(null);
    try {
      await revokeSession(sessionId);
      toast({ message: t("sessions.signedOut"), tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    } catch (e) {
      setRevokeError(
        apiErrorMessage(e, t("sessions.revokeFailed")),
      );
    } finally {
      setBusy(null);
    }
  }

  // Destructive: gate the "sign out everywhere" action via a
  // confirm dialog so a stray click doesn't yank the user's
  // other browsers / installed PWAs offline.
  const [confirmingRevokeOthers, setConfirmingRevokeOthers] = useState(false);

  async function doRevokeOthers() {
    setBusy("others");
    setRevokeError(null);
    setConfirmingRevokeOthers(false);
    try {
      const result = await revokeOtherSessions();
      toast({
        message: result.revoked === 0
          ? t("sessions.noOthers")
          : tn("sessions.signedOutOthers", result.revoked),
        tone: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    } catch (e) {
      setRevokeError(
        apiErrorMessage(e, t("sessions.revokeOthersFailed")),
      );
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) {
    return (
      <PageShell>
        <PageHeader title={navWord("Devices")} />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    return (
      <PageShell>
        <PageHeader title={navWord("Devices")} />
        <ErrorState
          message={
            `${t("sessions.loadFailed")} ${apiErrorMessage(error, "")}`.trimEnd()
          }
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  const sessions = data.sessions;
  const otherCount = sessions.filter((s) => !s.is_current).length;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Devices")}
        subtitle={tn("sessions.count", sessions.length)}
        actions={otherCount > 0 ? (
          <Button
            tone="secondary"
            size="sm"
            busy={busy === "others"}
            disabled={busy !== null}
            onClick={() => setConfirmingRevokeOthers(true)}
          >
            {t("sessions.everywhereElse")}
          </Button>
        ) : undefined}
      />

      {revokeError && (
        <div style={{ marginBottom: space.lg }}>
          <Alert tone="error">{revokeError}</Alert>
        </div>
      )}

      <Section
        title={
          <>
            {t("sessions.signedIn")}
            <InfoTip text={t("sessions.signedInTip")} />
          </>
        }
      >
        <Card>
          <Table>
            <thead>
              <tr>
                {[t("sessions.colDevice"), t("sessions.colLast"), t("sessions.colSignedIn"), "IP", ""]
                  .map((h, i) => (
                    <th key={i} style={thStyle}>{h}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <SessionRow
                  key={s.session_id}
                  session={s}
                  busy={busy === s.session_id}
                  disabled={busy !== null}
                  onRevoke={() => { void onRevoke(s.session_id); }}
                />
              ))}
            </tbody>
          </Table>
        </Card>
      </Section>


      <ConfirmDialog
        open={confirmingRevokeOthers}
        title={t("sessions.othersTitle")}
        message={t("sessions.othersBody")}
        confirmLabel={t("sessions.everywhereElse")}
        confirmTone="danger"
        busy={busy === "others"}
        onConfirm={() => { void doRevokeOthers(); }}
        onCancel={() => setConfirmingRevokeOthers(false)}
      />
    </PageShell>
  );
}


function SessionRow({
  session, busy, disabled, onRevoke,
}: {
  session: ActiveSessionRow;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  return (
    <tr>
      <td style={tdStyle}>
        <div className={styles.deviceCell}>
          <strong>{describeUserAgent(session.user_agent)}</strong>
          {session.is_current && (
            <span className={styles.currentTag}>{t("sessions.thisDevice")}</span>
          )}
        </div>
        <div className={styles.uaRaw} title={session.user_agent || t("sessions.noUa")}>
          {session.user_agent || t("sessions.noUa")}
        </div>
      </td>
      <td style={tdStyle}>
        <span className={styles.timestamp}>
          {formatRelative(session.last_used_at)}
        </span>
      </td>
      <td style={tdStyle}>
        <span className={styles.timestamp}>
          {formatRelative(session.started_at)}
        </span>
      </td>
      <td style={tdStyle}>
        <span style={{ fontFamily: tokens.fontMono, fontSize: "0.85rem" }}>
          {session.ip_address || "—"}
        </span>
      </td>
      <td style={tdStyle}>
        {session.is_current ? (
          <span className={styles.muted}>{t("sessions.current")}</span>
        ) : (
          <Button
            tone="danger"
            size="sm"
            busy={busy}
            disabled={disabled}
            onClick={onRevoke}
          >
            {t("sessions.signOut")}
          </Button>
        )}
      </td>
    </tr>
  );
}


// Heuristic User-Agent → "Chrome on macOS" parser. Doesn't have to
// be perfect — falls back to the raw string in a sub-line so the
// detail-conscious user still sees what was captured.
// Product names, the same in every language.
const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

function describeUserAgent(ua: string): string {
  if (!ua) return t("sessions.unknown");
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" :
    /curl\//.test(ua) ? "curl" :
    /python-requests/.test(ua) ? "python-requests" :
    t("sessions.browser");
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1] ?? "";
  return platform ? t("sessions.browserOn", { browser, platform }) : browser;
}


// "5 minutes ago", "Today at 14:23", "2 days ago", "May 12".
function formatRelative(iso: string): string {
  if (!iso) return "—";
  const d = parseTimestamp(iso);
  if (!d) return iso;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return t("sessions.justNow");
  if (diffMs < 3_600_000) {
    const m = Math.floor(diffMs / 60_000);
    return tn("sessions.minutesAgo", m);
  }
  if (diffMs < 24 * 3_600_000) {
    const h = Math.floor(diffMs / 3_600_000);
    return tn("sessions.hoursAgo", h);
  }
  if (diffMs < 7 * 24 * 3_600_000) {
    const days = Math.floor(diffMs / (24 * 3_600_000));
    return tn("sessions.daysAgo", days);
  }
  return diffMs < 300 * 24 * 3_600_000 ? formatShortDate(iso) : formatDate(iso);
}

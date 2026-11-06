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
  PageHeader, PageShell, Section, space, DataTable,
  useToast, type DataColumn,
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
          <DataTable
            columns={sessionColumns({
              busyId: busy,
              onRevoke: (id) => { void onRevoke(id); },
            })}
            rows={sessions}
            rowKey={(s) => s.session_id}
            emptyTitle={t("sessions.none")}
          />
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


/** Signed-in devices as the kit ``<DataTable>``, built during render
 *  so the headings follow the language. The current session is
 *  marked and can't be signed out from here. */
function sessionColumns({
  busyId, onRevoke,
}: {
  /** The session being signed out ("others" while signing out the rest). */
  busyId: string | null;
  onRevoke: (sessionId: string) => void;
}): DataColumn<ActiveSessionRow>[] {
  return [
    {
      key: "device", header: t("sessions.colDevice"),
      render: (session) => (
        <>
          <div className={styles.deviceCell}>
            <strong>{describeUserAgent(session.user_agent)}</strong>
            {session.is_current && (
              <span className={styles.currentTag}>{t("sessions.thisDevice")}</span>
            )}
          </div>
          <div className={styles.uaRaw} title={session.user_agent || t("sessions.noUa")}>
            {session.user_agent || t("sessions.noUa")}
          </div>
        </>
      ),
    },
    {
      key: "last", header: t("sessions.colLast"),
      render: (session) => (
        <span className={styles.timestamp}>{formatRelative(session.last_used_at)}</span>
      ),
    },
    {
      key: "started", header: t("sessions.colSignedIn"),
      render: (session) => (
        <span className={styles.timestamp}>{formatRelative(session.started_at)}</span>
      ),
    },
    {
      key: "ip", header: IP_HEADER,
      render: (session) => (
        <span className={styles.ip}>{session.ip_address || "—"}</span>
      ),
    },
    {
      key: "actions", header: "", label: "",
      render: (session) => (session.is_current ? (
        <span className={styles.muted}>{t("sessions.current")}</span>
      ) : (
        <Button
          tone="danger"
          size="sm"
          busy={busyId === session.session_id}
          disabled={busyId !== null}
          onClick={() => onRevoke(session.session_id)}
        >
          {t("sessions.signOut")}
        </Button>
      )),
    },
  ];
}

// The same in every language.
const IP_HEADER = "IP";


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

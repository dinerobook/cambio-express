import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  subscribePush,
  unsubscribePush,
  updateNotifications,
  useNotifications,
  usePushStatus,
  type NotificationsUpdateBody,
} from "../api/account";
import { apiErrorMessage } from "../lib/api";
import {
  getPushPermission,
  hasLocalSubscription,
  pushSupported,
  subscribeBrowser,
  unsubscribeBrowser,
} from "../lib/push";
import {
  Alert, Button, Card, Checkbox, ErrorState, FormActions, InfoTip, Loading,
  PageHeader, PageShell, Section, Table, tdStyle, thStyle, tokens,
  useToast,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./AccountNotifications.module.css";
import { BRAND_NAME } from "../lib/brand";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/account/notifications — per-user boolean toggles.
//
// Trial-reminder toggle is interactive only when the user's role
// + store make it relevant (admin/owner of an actively-trialing
// store). For everyone else (employees, paid stores, superadmin)
// it renders disabled with an inline "not applicable" note —
// matches the legacy Jinja behavior so users see the full
// preference surface.

export default function AccountNotifications() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useNotifications();

  const [draft, setDraft] = useState<NotificationsUpdateBody>({});
  const [busy, setBusy]   = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const toast = useToast();
  const t = useT();

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable draft from server-fetched notifications once GET resolves
    setDraft({
      notify_trial_reminders:        data.notify_trial_reminders,
      notify_announcement_email:     data.notify_announcement_email,
      notify_locked_day_digest:      data.notify_locked_day_digest,
      notify_daily_summary:          data.notify_daily_summary,
      notify_trial_reminders_push:   data.notify_trial_reminders_push,
      notify_announcement_push:      data.notify_announcement_push,
      notify_locked_day_digest_push: data.notify_locked_day_digest_push,
      notify_daily_summary_push:     data.notify_daily_summary_push,
      notify_high_variance:          data.notify_high_variance,
      notify_high_variance_push:     data.notify_high_variance_push,
      notify_store_offline:          data.notify_store_offline,
      notify_store_offline_push:     data.notify_store_offline_push,
      notify_ticket_updates:         data.notify_ticket_updates,
      notify_ticket_updates_push:    data.notify_ticket_updates_push,
      notify_new_sign_in:            data.notify_new_sign_in,
      notify_new_sign_in_push:       data.notify_new_sign_in_push,
    });
  }, [data]);

  // The draft is empty until the GET hydrates it; that is the baseline.
  const { dirty, markSaved } = useDirtyBaseline(
    draft, Object.keys(draft).length > 0,
  );
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("notify.unsavedMessage"),
  });

  function set<K extends keyof NotificationsUpdateBody>(
    key: K, value: NotificationsUpdateBody[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setServerError(null);
    try {
      await updateNotifications(draft);
      markSaved();
      toast({ message: t("notify.saved"), tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["account", "notifications"] });
    } catch (err) {
      setServerError(
        apiErrorMessage(err, t("notify.networkError")),
      );
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <PageShell>
        <PageHeader title={navWord("Notifications")} />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    return (
      <PageShell>
        <PageHeader title={navWord("Notifications")} />
        <ErrorState
          message={`${t("notify.loadFailed")} ${apiErrorMessage(error, "")}`.trimEnd()}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  const trialApplies = data.trial_toggle_applies;
  const trialNotApplicableNote = data.role === "admin" || data.role === "owner"
    ? t("notify.trialNaPaid")
    : t("notify.trialNaRole");
  const digestApplies = data.locked_day_digest_applies;
  const summaryApplies = data.daily_summary_applies;

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader title={navWord("Notifications")} subtitle={t("notify.subtitle")} />

      <div className={styles.grid}>
        <Section title={t("notify.yourPrefs")}>
          <Card>
            {serverError && <Alert tone="error">{serverError}</Alert>}

            <form onSubmit={onSubmit} autoComplete="off">
              <div className={styles.kindHeader}>
                <span />
                <span className={styles.channelLabel}>{t("notify.email")}</span>
                <span className={styles.channelLabel}>{t("notify.push")}</span>
              </div>

              <PrefKindRow
                title={t("notify.trialTitle")}
                disabled={busy || !trialApplies}
                emailChecked={draft.notify_trial_reminders ?? false}
                emailOnChange={(v) => set("notify_trial_reminders", v)}
                pushChecked={draft.notify_trial_reminders_push ?? false}
                pushOnChange={(v) => set("notify_trial_reminders_push", v)}
              >
                {t("notify.trialBody")}
                {!trialApplies && (
                  <>
                    <br />
                    <em className={styles.notApplicable}>
                      {trialNotApplicableNote}
                    </em>
                  </>
                )}
              </PrefKindRow>

              <PrefKindRow
                title={t("notify.announceTitle")}
                disabled={busy}
                emailChecked={draft.notify_announcement_email ?? false}
                emailOnChange={(v) => set("notify_announcement_email", v)}
                pushChecked={draft.notify_announcement_push ?? false}
                pushOnChange={(v) => set("notify_announcement_push", v)}
              >
                {t("notify.announceBody")}
              </PrefKindRow>

              <PrefKindRow
                title={t("notify.digestTitle")}
                disabled={busy || !digestApplies}
                emailChecked={draft.notify_locked_day_digest ?? false}
                emailOnChange={(v) => set("notify_locked_day_digest", v)}
                pushChecked={draft.notify_locked_day_digest_push ?? false}
                pushOnChange={(v) => set("notify_locked_day_digest_push", v)}
              >
                {t("notify.digestBody")}
                {!digestApplies && (
                  <>
                    <br />
                    <em className={styles.notApplicable}>
                      {t("notify.digestNa")}
                    </em>
                  </>
                )}
              </PrefKindRow>

              <PrefKindRow
                title={t("notify.summaryTitle")}
                disabled={busy || !summaryApplies}
                emailChecked={draft.notify_daily_summary ?? false}
                emailOnChange={(v) => set("notify_daily_summary", v)}
                pushChecked={draft.notify_daily_summary_push ?? false}
                pushOnChange={(v) => set("notify_daily_summary_push", v)}
              >
                {t("notify.summaryBody")}
                {!summaryApplies && (
                  <>
                    <br />
                    <em className={styles.notApplicable}>
                      {t("notify.digestNa")}
                    </em>
                  </>
                )}
              </PrefKindRow>

              <PrefKindRow
                title={t("notify.ticketTitle")}
                disabled={busy}
                emailChecked={draft.notify_ticket_updates ?? false}
                emailOnChange={(v) => set("notify_ticket_updates", v)}
                pushChecked={draft.notify_ticket_updates_push ?? false}
                pushOnChange={(v) => set("notify_ticket_updates_push", v)}
              >
                {t("notify.ticketBody")}
              </PrefKindRow>

              <PrefKindRow
                title={t("notify.signInTitle")}
                disabled={busy}
                emailChecked={draft.notify_new_sign_in ?? false}
                emailOnChange={(v) => set("notify_new_sign_in", v)}
                pushChecked={draft.notify_new_sign_in_push ?? false}
                pushOnChange={(v) => set("notify_new_sign_in_push", v)}
              >
                {t("notify.signInBody")}
              </PrefKindRow>

              {data.high_variance_applies && (
                <PrefKindRow
                  title={t("notify.varianceTitle")}
                  disabled={busy}
                  emailChecked={draft.notify_high_variance ?? false}
                  emailOnChange={(v) => set("notify_high_variance", v)}
                  pushChecked={draft.notify_high_variance_push ?? false}
                  pushOnChange={(v) => set("notify_high_variance_push", v)}
                >
                  {t("notify.varianceBody")}
                </PrefKindRow>
              )}

              {data.store_offline_applies && (
                <PrefKindRow
                  title={t("notify.offlineTitle")}
                  disabled={busy}
                  emailChecked={draft.notify_store_offline ?? false}
                  emailOnChange={(v) => set("notify_store_offline", v)}
                  pushChecked={draft.notify_store_offline_push ?? false}
                  pushOnChange={(v) => set("notify_store_offline_push", v)}
                >
                  {t("notify.offlineBody")}
                </PrefKindRow>
              )}

              <FormActions guard={guard}>
                <Button type="submit" busy={busy} disabled={busy}>
                  {busy ? t("common.saving") : t("notify.save")}
                </Button>
              </FormActions>
            </form>
          </Card>
        </Section>

        <Section title={t("notify.browserTitle")}>
          <BrowserPushCard />
        </Section>

        <Section
          title={
            <>
              {t("notify.whatWeSend", { brand: BRAND_NAME })}
              <InfoTip text={t("notify.whatWeSendTip")} />
            </>
          }
        >
          <Card>
            <Table>
              <thead>
                <tr>
                  {[t("notify.colChannel"), t("notify.colWhat"), t("notify.colControl")].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <Row
                  channel="notify.chEmail" what="notify.wReset"
                  control="notify.cAlwaysOn"
                  muted
                />
                <Row
                  channel="notify.chEmail" what="notify.wTrial"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chEmail"
                  what="notify.wAnnounce"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chEmail"
                  what="notify.wDigest"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chEmail"
                  what="notify.wSummary"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chEmailPush"
                  what="notify.wTicket"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chEmailPush"
                  what="notify.wSignIn"
                  control="notify.cToggle"
                />
                <Row
                  channel="notify.chBrowserPush"
                  what="notify.wBrowser"
                  control="notify.cBrowser"
                />
                <Row
                  channel="notify.chBanner"
                  what="notify.wBanner"
                  control="notify.cBanner"
                  muted
                />
              </tbody>
            </Table>
          </Card>
        </Section>
      </div>
    </PageShell>
  );
}


function PrefKindRow({
  title, disabled,
  emailChecked, emailOnChange,
  pushChecked,  pushOnChange,
  children,
}: {
  title:         string;
  disabled:      boolean;
  emailChecked:  boolean;
  emailOnChange: (v: boolean) => void;
  pushChecked:   boolean;
  pushOnChange:  (v: boolean) => void;
  children:      React.ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.kindRow}>
      <div className={styles.prefBody}>
        <div className={styles.prefTitleRow}>
          <span className={styles.prefTitle}>{title}</span>
          <ChannelStatusBadge
            disabled={disabled}
            emailOn={emailChecked}
            pushOn={pushChecked}
          />
        </div>
        <div className={styles.prefDesc}>{children}</div>
      </div>
      <div className={styles.channelCell}>
        <Checkbox
          checked={emailChecked}
          disabled={disabled}
          onChange={emailOnChange}
          aria-label={t("notify.emailAria", { title })}
        />
      </div>
      <div className={styles.channelCell}>
        <Checkbox
          checked={pushChecked}
          disabled={disabled}
          onChange={pushOnChange}
          aria-label={t("notify.pushAria", { title })}
        />
      </div>
    </div>
  );
}


function Row({
  channel, what, control, muted,
}: {
  channel: MessageKey; what: MessageKey; control: MessageKey; muted?: boolean;
}) {
  const t = useT();
  const ctrlStyle: React.CSSProperties = muted
    ? { ...tdStyle, color: tokens.textMuted }
    : tdStyle;
  return (
    <tr>
      <td style={tdStyle}>{t(channel)}</td>
      <td style={tdStyle}>{t(what)}</td>
      <td style={ctrlStyle}>{t(control)}</td>
    </tr>
  );
}


function BrowserPushCard() {
  const queryClient = useQueryClient();
  const { data: status, isLoading } = usePushStatus();
  const [localSubscribed, setLocalSubscribed] = useState<boolean>(false);
  const [permission, setPermission] = useState(getPushPermission());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const t = useT();
  const supported = pushSupported();

  // Sync local "is this browser subscribed?" once on mount + after
  // every action.  The server cross-device count comes from
  // ``usePushStatus``; this hook is purely about THIS browser.
  useEffect(() => {
    void (async () => {
      const has = await hasLocalSubscription();
      setLocalSubscribed(has);
    })();
  }, []);

  if (!supported) {
    return (
      <Card>
        <p className={styles.pushUnsupported}>
          {t("notify.pushUnsupported")}
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return <Card><Loading /></Card>;
  }

  if (!status?.enabled) {
    return (
      <Card>
        <p className={styles.pushUnsupported}>
          {t("notify.pushNotConfigured")}
        </p>
      </Card>
    );
  }

  async function onEnable() {
    if (!status?.public_key) return;
    setBusy(true); setError(null);
    try {
      const env = await subscribeBrowser(status.public_key);
      await subscribePush({
        endpoint:   env.endpoint,
        p256dh:     env.p256dh,
        auth:       env.auth,
        user_agent: env.userAgent,
      });
      setLocalSubscribed(true);
      setPermission(getPushPermission());
      toast({
        message: t("notify.enabledToast"),
        tone: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["account", "push-status"] });
    } catch (err) {
      setError(
        apiErrorMessage(err, t("notify.enableFailed"), { anyError: true }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true); setError(null);
    try {
      const endpoint = await unsubscribeBrowser();
      if (endpoint) {
        await unsubscribePush({ endpoint });
      }
      setLocalSubscribed(false);
      toast({
        message: t("notify.disabledToast"),
        tone: "success",
      });
      queryClient.invalidateQueries({ queryKey: ["account", "push-status"] });
    } catch (err) {
      setError(
        apiErrorMessage(err, t("notify.disableFailed"), { anyError: true }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.pushRow}>
        <div className={styles.pushStatus}>
          <span
            className={`${styles.pushDot} ${localSubscribed ? styles.pushDotOn : styles.pushDotOff}`}
            aria-hidden="true"
          />
          {localSubscribed
            ? t("notify.onHere")
            : t("notify.offHere")}
          {status.device_count > 0 && (
            <span className={styles.pushDeviceHint}>
              {" "}{tn("notify.devices", status.device_count, fmtNumber)}
            </span>
          )}
        </div>

        {error && <Alert tone="error">{error}</Alert>}
        {permission === "denied" && (
          <Alert tone="info">
            {t("notify.blocked")}
          </Alert>
        )}

        <div className={styles.pushActions}>
          {!localSubscribed && (
            <Button
              type="button"
              busy={busy}
              disabled={busy || permission === "denied"}
              onClick={() => { void onEnable(); }}
            >
              {busy ? t("notify.enabling") : t("notify.enable")}
            </Button>
          )}
          {localSubscribed && (
            <Button
              type="button" tone="secondary"
              busy={busy} disabled={busy}
              onClick={() => { void onDisable(); }}
            >
              {busy ? t("notify.disabling") : t("notify.disable")}
            </Button>
          )}
        </div>

        <p className={styles.pushDeviceHint}>
          {t("notify.pushHint")}
        </p>
      </div>
    </Card>
  );
}


/** Inline pill on each notification kind summarizing which
 *  channels are active.  Helps users see "I'll get this as
 *  push only" without parsing two adjacent checkboxes.
 *
 *  Suppressed when the row is disabled (inapplicable kind) —
 *  showing "Both off" on an irrelevant row reads as a problem
 *  to fix, but it's actually correct + intentional. */
function ChannelStatusBadge({
  disabled, emailOn, pushOn,
}: { disabled: boolean; emailOn: boolean; pushOn: boolean }) {
  const t = useT();
  if (disabled) return null;
  const both = emailOn && pushOn;
  const none = !emailOn && !pushOn;
  let label: MessageKey;
  let kind: "on" | "off" | "mixed";
  if (both)        { label = "notify.badgeBoth";  kind = "on"; }
  else if (none)   { label = "notify.badgeOff";   kind = "off"; }
  else if (emailOn){ label = "notify.badgeEmail"; kind = "mixed"; }
  else             { label = "notify.badgePush";  kind = "mixed"; }
  return (
    <span
      className={`${styles.statusBadge} ${
        kind === "on"   ? styles.statusBadgeOn
      : kind === "off"  ? styles.statusBadgeOff
                        : styles.statusBadgeMixed
      }`}
    >
      {t(label)}
    </span>
  );
}

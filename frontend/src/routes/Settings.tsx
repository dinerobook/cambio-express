import { Fragment, useEffect, useState, type FormEvent } from "react";
import { Outlet } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  changePassword,
  deletePasskey,
  registerPasskey,
  updateProfile,
  updateStoreInfo,
  usePasskeys,
  useProfile,
  useStoreInfo,
  type ProfileUpdateBody,
  type StoreHourEntry,
} from "../api/account";
import { redeemConnectCode } from "../api/owner";
import { ApiError, apiErrorMessage, downloadFile } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { formatDate, formatTimestamp } from "../lib/datetime";
import { timezoneFromAddress } from "../lib/timezoneFromAddress";
import { getCurrentIdentity } from "../lib/auth";
import { hasPermission } from "../lib/permissions";
import { passkeysSupported } from "../lib/webauthn";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  getLanguage, isLanguage, LANGUAGE_NAMES, LANGUAGES, setLanguage, t as translate,
  tNodes, useT,
  type MessageKey,
} from "../i18n";
import { navWord } from "../i18n/navWords";
import { roleLabel } from "../api/roles";
import { weekdayNameLong } from "../lib/datetime";
import {
  Alert, Button, ButtonLink, Card, Checkbox, ConfirmDialog, Empty,
  ErrorState, Field, FormActions, InfoTip, Input, Loading, PageHeader,
  PageShell, SectionTitle, Select, space, Switch, TabsBar, TabsLink,
  useToast,
} from "../components/ui";
import styles from "./Settings.module.css";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/settings — tabbed admin / account hub.  The route is a
// LAYOUT route (this default export renders the page chrome +
// `<Outlet />`); each tab is a child route mounted in App.tsx
// (`SettingsGeneral`, `SettingsTeam`, `SettingsBilling`,
// `SettingsSecurity`).  Tab URLs are deep-linkable, browser back
// works correctly, and each section's form-save logic stays
// independent.
//
// /app/settings (no sub-path) redirects to /app/settings/general
// so existing inbound links keep working.

export default function Settings() {
  const identity = getCurrentIdentity();
  const t = useT();
  // Which tabs show is NOT decided here. Each TabsLink hides itself
  // when the person cannot open its route (lib/access.ts), and the
  // route's <Gate> reads the same table — so a tab can never lead
  // to an empty page. An employee without settings rights sees
  // Profile + Security; an owner sees no Billing (they pay per store
  // from inside that store); superadmin sees no General (no store).
  return (
    <PageShell maxWidth="60rem" gap="1rem">

      <PageCrumbs />

      <PageHeader title={navWord("Settings")} subtitle={identity?.username || "—"} />

      <TabsBar>
        <TabsLink to="/settings/profile">{t("settings.tabProfile")}</TabsLink>
        <TabsLink to="/settings/general">{t("settings.tabGeneral")}</TabsLink>
        <TabsLink to="/settings/money-services">{navWord("Money services")}</TabsLink>
        <TabsLink to="/settings/billing">{navWord("Billing")}</TabsLink>
        <TabsLink to="/settings/referrals">{t("settings.tabReferrals")}</TabsLink>
        <TabsLink to="/settings/security">{t("settings.tabSecurity")}</TabsLink>
      </TabsBar>

      <Outlet />
    </PageShell>
  );
}


/** Tab content components.  Each is registered as a child route in
 *  App.tsx.  They wrap the existing pre-tabs `…Card` components
 *  unchanged, so the form-save logic + state management didn't have
 *  to be rewritten — the refactor is purely structural.  */
export function SettingsProfile() {
  return <ProfileCard />;
}

export function SettingsGeneral() {
  return (
    <>
      <StoreInfoCard />
      <OwnerAccessCard />
    </>
  );
}

export function SettingsBilling() {
  return <SubscriptionCard />;
}

export function SettingsSecurity() {
  return (
    <>
      <ChangePasswordCard />
      <PasskeysCard />
      <DataExportCard />
    </>
  );
}


function DataExportCard() {
  const [busy, setBusy] = useState(false);
  const toastApiError = useApiErrorToast();
  const t = useT();
  async function handleExport() {
    setBusy(true);
    try {
      // The shared download path: refreshes an expired session like
      // every API call, and names the file from the server's
      // Content-Disposition.
      await downloadFile("/api/v2/auth/account/export", {
        fallbackName: "dinerobook-data.json",
      });
    } catch (err) {
      toastApiError(err, t("settings.exportFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <SectionTitle>
        {t("settings.exportTitle")}
        <InfoTip text={t("settings.exportTip")} />
      </SectionTitle>
      <Button onClick={() => { void handleExport(); }} busy={busy} type="button">
        {t("settings.exportButton")}
      </Button>
    </Card>
  );
}

function ProfileCard() {
  const queryClient = useQueryClient();
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useProfile();

  const toast = useToast();
  const [draft, setDraft] = useState<ProfileUpdateBody>({});
  // Last-saved snapshot; the form is "dirty" when `draft` drifts from it.
  const [baseline, setBaseline] = useState<ProfileUpdateBody>({});
  const [busy, setBusy]   = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data) return;
    // Admin / owner accounts sign in with their email (it's stored as
    // the `username`), and the separate notices `email` is left blank
    // at signup. Surface the login email as the Email so the field
    // isn't confusingly empty; saving persists it so notices reach
    // the same address. Employees (username isn't an email) are
    // untouched.
    const loginIsEmail = (data.username || "").includes("@");
    const hydrated: ProfileUpdateBody = {
      full_name:        data.full_name,
      email:            data.email || (loginIsEmail ? data.username : ""),
      phone:            data.phone,
      theme_preference: data.theme_preference,
      language:         data.language,
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable draft + dirty baseline from server-fetched profile so inputs are controlled from first paint
    setDraft(hydrated);
    setBaseline(hydrated);
  }, [data]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("profile.unsavedMessage"),
  });

  function set<K extends keyof ProfileUpdateBody>(
    key: K, value: ProfileUpdateBody[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (fieldErrors[key as string]) {
      setFieldErrors((e) => {
        const next = { ...e }; delete next[key as string]; return next;
      });
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setServerError(null);
    setFieldErrors({});
    try {
      await updateProfile(draft);
      setBaseline(draft);  // edits are now the saved state — clear dirty
      // The app switches language as soon as the choice is saved.
      if (isLanguage(draft.language)) setLanguage(draft.language);
      toast({ message: t("profile.updated"), tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["account", "profile"] });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const detail = (err.body as { detail?: { field_errors?: Record<string, string> } })?.detail;
        if (detail?.field_errors) {
          setFieldErrors(detail.field_errors);
        } else {
          setServerError(apiErrorMessage(err, t("common.networkError")));
        }
      } else {
        setServerError(apiErrorMessage(err, t("common.networkError")));
      }
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) {
    return <Card><SectionTitle>{t("profile.personalInfo")}</SectionTitle><Loading /></Card>;
  }
  if (isError || !data) {
    return (
      <Card>
        <SectionTitle>{t("profile.personalInfo")}</SectionTitle>
        <ErrorState
          message={`${t("profile.loadFailed")} ${apiErrorMessage(error, "")}`.trimEnd()}
          onRetry={() => { void refetch(); }}
        />
      </Card>
    );
  }

  const memberSince = formatDate(data.created_at);
  const lastLogin = data.last_login_at
    ? formatTimestamp(data.last_login_at)
    : "—";

  // Email-login accounts (admin / owner) sign in with their email —
  // there's no separate username to show, so we hide that read-only
  // row and treat the Email field as the login/account email.
  const loginIsEmail = data.username.includes("@");

  return (
    <Card>
      <SectionTitle>{t("profile.personalInfo")}</SectionTitle>
      <p className={styles.profileLead}>
        {loginIsEmail ? t("profile.leadEmail") : t("profile.leadUsername")}
      </p>

      {serverError && <Alert tone="error">{serverError}</Alert>}

      <form
        onSubmit={onSubmit}
        autoComplete="off"
        style={{ display: "flex", flexDirection: "column", gap: space.lg, marginTop: space.lg }}
      >
        <Field label={t("profile.displayName")} error={fieldErrors.full_name}>
          <Input
            type="text" maxLength={120} required
            value={draft.full_name ?? ""}
            onChange={(e) => set("full_name", e.target.value)}
            disabled={busy}
          />
        </Field>

        <Field
          label={t("common.email")}
          error={fieldErrors.email}
          hint={loginIsEmail
            ? t("profile.emailHintLogin")
            : t("profile.emailHint")}
        >
          <Input
            type="email" maxLength={255}
            autoComplete="email"
            placeholder="you@example.com"
            value={draft.email ?? ""}
            onChange={(e) => set("email", e.target.value)}
            disabled={busy}
          />
        </Field>

        <Field label={t("common.phone")} error={fieldErrors.phone}>
          <Input
            type="tel" maxLength={40}
            autoComplete="tel"
            placeholder="+1 555 123 4567"
            value={draft.phone ?? ""}
            onChange={(e) => set("phone", e.target.value)}
            disabled={busy}
          />
        </Field>

        {/* Per-user timezone was removed — these are brick-and-mortar
            stores, so date/time rendering follows the store's timezone
            (set on Settings → General, suggested from the address). One
            timezone per store keeps reports + audit trails consistent
            across the whole team. */}

        <Field
          label={<>{t("profile.appearance")}<InfoTip text={t("profile.appearanceTip")} /></>}
          error={fieldErrors.theme_preference}
        >
          <Switch
            checked={(draft.theme_preference ?? "dark") === "light"}
            onChange={(on) =>
              set("theme_preference", on ? "light" : "dark")
            }
            disabled={busy}
          >
            {t("profile.lightTheme")}
          </Switch>
        </Field>

        <Field
          label={<>{t("common.language")}<InfoTip text={t("profile.languageHint")} /></>}
          error={fieldErrors.language}
        >
          <Select
            // Never chosen (null): show what this device is showing.
            value={draft.language ?? getLanguage()}
            onChange={(e) => {
              const next = e.target.value;
              if (isLanguage(next)) set("language", next);
            }}
            disabled={busy}
          >
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang} lang={lang}>
                {LANGUAGE_NAMES[lang]}
              </option>
            ))}
          </Select>
        </Field>

        <hr className={styles.profileHr} />

        <div className={styles.profileReadOnlyGrid}>
          {!loginIsEmail && (
            <ProfileReadOnly label={t("profile.username")} value={data.username} />
          )}
          <ProfileReadOnly label={t("employee.role")} value={roleLabel(data.role)} />
          <ProfileReadOnly label={t("profile.memberSince")} value={memberSince} />
          <ProfileReadOnly label={t("profile.lastSignIn")} value={lastLogin} />
        </div>

        <FormActions guard={guard}>
          <Button type="submit" busy={busy} disabled={busy || !isDirty}>
            {busy ? t("common.saving") : t("profile.save")}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

function ProfileReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <Field label={label}>
      <Input
        type="text" disabled value={value || "—"}
        style={{ opacity: 0.7, cursor: "not-allowed" }}
      />
    </Field>
  );
}

function PasskeysCard() {
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const { data, isLoading, isError, refetch } = usePasskeys();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [newName, setNewName] = useState("");
  // Pending passkey staged for removal — null when no confirm
  // is showing.  Holds id + label so the dialog can reference
  // both without re-resolving from the list.
  const [pendingRemove, setPendingRemove] =
    useState<{ id: number; label: string } | null>(null);
  const supported = passkeysSupported();
  const t = useT();

  if (identity == null) return null;

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["account", "passkeys"] });
  }

  async function doRemove() {
    if (!pendingRemove) return;
    const { id } = pendingRemove;
    setErr(null); setBusyId(id);
    try {
      await deletePasskey(id);
      refresh();
      setPendingRemove(null);
    } catch (e) {
      setErr(apiErrorMessage(e, t("passkeys.removeFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function add() {
    setErr(null); setAddBusy(true);
    try {
      await registerPasskey(newName.trim());
      setAdding(false);
      setNewName("");
      refresh();
    } catch (e) {
      // navigator.credentials.create() rejects on cancel / wrong
      // device / etc. with browser-specific messages — surface
      // them as-is so users see the actual reason.
      const msg = apiErrorMessage(e, t("passkeys.createFailed"), { anyError: true });
      setErr(msg);
    } finally {
      setAddBusy(false);
    }
  }

  return (
    <Card>
      <div className={styles.sectionHead}>
        <div style={{ flex: 1 }}>
          <SectionTitle>{t("passkeys.title")}</SectionTitle>
        </div>
        {supported && !adding && (
          <Button
            tone="secondary" size="sm"
            onClick={() => { setAdding(true); setErr(null); }}
          >
            {t("passkeys.add")}
          </Button>
        )}
      </div>
      <p className={styles.helpText}>
        {t("passkeys.help")}
      </p>
      {!supported && (
        <Alert tone="info">
          {t("passkeys.unsupported")}
        </Alert>
      )}
      {adding && (
        <div className={styles.addInset}>
          <Field label={t("passkeys.nickname")}>
            <Input
              type="text" value={newName} maxLength={120}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("passkeys.nicknamePlaceholder")}
              autoFocus disabled={addBusy}
            />
          </Field>
          <div className={styles.addInsetActions}>
            <Button onClick={add} busy={addBusy} disabled={addBusy} size="sm">
              {addBusy ? t("passkeys.creating") : t("passkeys.create")}
            </Button>
            <Button
              tone="secondary" size="sm"
              onClick={() => { setAdding(false); setNewName(""); setErr(null); }}
              disabled={addBusy}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("passkeys.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}
      {data && data.passkeys.length === 0 && !isLoading && (
        <Empty>{t("passkeys.none")}</Empty>
      )}
      {data && data.passkeys.length > 0 && (
        <ul className={styles.list}>
          {data.passkeys.map((p) => (
            <li key={p.id} className={styles.row}>
              <span className={styles.rowBody}>
                <div className={styles.rowTitle}>
                  {p.name || t("passkeys.unnamed")}
                </div>
                <div className={styles.rowMeta}>
                  {p.last_used_at
                    ? t("passkeys.addedUsed", {
                        date: formatDate(p.created_at), used: formatDate(p.last_used_at),
                      })
                    : t("passkeys.added", { date: formatDate(p.created_at) })}
                </div>
              </span>
              <Button
                tone="secondary" size="sm"
                onClick={() => setPendingRemove({ id: p.id, label: p.name })}
                busy={busyId === p.id}
                disabled={busyId === p.id}
              >
                {busyId === p.id ? t("passkeys.removing") : t("passkeys.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {err && <Alert tone="error">{err}</Alert>}
      <ConfirmDialog
        open={pendingRemove != null}
        title={t("passkeys.removeTitle")}
        message={t("passkeys.removeBody", {
          name: pendingRemove?.label || t("passkeys.thisDevice"),
        })}
        confirmLabel={t("passkeys.remove")}
        confirmTone="danger"
        busy={busyId != null}
        onConfirm={() => { void doRemove(); }}
        onCancel={() => setPendingRemove(null)}
      />
    </Card>
  );
}

function SubscriptionCard() {
  const identity = getCurrentIdentity();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useT();
  const canManage =
    identity?.role === "admin" ||
    identity?.role === "owner" ||
    identity?.role === "superadmin";
  if (!canManage || identity?.store_id == null) return null;

  async function openPortal() {
    setErr(null);
    setBusy(true);
    try {
      const { openBillingPortal } = await import("../api/billing");
      const result = await openBillingPortal();
      window.location.assign(result.url);
    } catch (e) {
      // 409 = no Stripe customer yet (trial store) — push to subscribe
      if (e instanceof ApiError && e.status === 409) {
        window.location.assign("/app/subscribe");
        return;
      }
      setErr(apiErrorMessage(e, t("subscription.portalFailed")));
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>{t("subscription.title")}</SectionTitle>
      <p className={styles.subscriptionInfo}>
        {t("subscription.info")}
      </p>
      <div className={styles.actionsRow}>
        <ButtonLink to="/subscribe" tone="primary">
          {t("subscription.choose")}
        </ButtonLink>
        <Button
          tone="secondary"
          onClick={openPortal}
          busy={busy}
          disabled={busy}
        >
          {busy ? t("subscription.opening") : t("subscription.manage")}
        </Button>
      </div>
      {err && <Alert tone="error">{err}</Alert>}
    </Card>
  );
}

function StoreInfoCard() {
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const { data, isLoading, isError, refetch } = useStoreInfo();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [legalName, setLegalName] = useState("");
  const [ein, setEin] = useState("");
  const [businessAddress, setBusinessAddress] = useState("");
  const [taxRatePct, setTaxRatePct] = useState("");
  const [salesTaxPct, setSalesTaxPct] = useState("");
  const [receiptLogoUrl, setReceiptLogoUrl] = useState("");
  const [receiptFooter, setReceiptFooter] = useState("");
  const [receiptTaxId, setReceiptTaxId] = useState("");
  const [timezone, setTimezone] = useState("");
  const [hours, setHours] = useState<StoreHourEntry[]>(() => defaultHours());
  const [enforceHours, setEnforceHours] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Last-saved snapshot (JSON) — the form is dirty when it drifts.
  const [baseline, setBaseline] = useState<string>("");
  const toast = useToast();
  const t = useT();

  // Serialize every editable field into one comparable snapshot. Same
  // key order here + at hydrate so the dirty compare is stable.
  const snapshot = (h: StoreHourEntry[], enforce: boolean) => JSON.stringify({
    name, email, phone, address, legalName, ein, businessAddress,
    taxRatePct, salesTaxPct, receiptLogoUrl, receiptFooter, receiptTaxId,
    timezone, hours: h, enforceHours: enforce,
  });

  // Hydrate the form from the read-side row when it arrives.
  // Federal tax is stored as a decimal (0.01 = 1%) but operators
  // think in percents — display + edit accordingly.
  useEffect(() => {
    if (!data?.store) return;
    const hydratedHours =
      data.store.store_hours && data.store.store_hours.length === 7
        ? data.store.store_hours.map((h) => ({ ...h }))
        : defaultHours();
    const taxPct = ((data.store.federal_tax_rate || 0) * 100).toFixed(2);
    const salesPct = ((data.store.sales_tax_rate || 0) * 100).toFixed(2);
    const enforce = Boolean(data.store.enforce_business_hours);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable store-settings fields + dirty baseline from server-fetched row (federal_tax_rate gets a decimal->percent conversion for display)
    setName(data.store.name);
    setEmail(data.store.email);
    setPhone(data.store.phone);
    setAddress(data.store.address);
    setLegalName(data.store.legal_name);
    setEin(data.store.ein);
    setBusinessAddress(data.store.business_address);
    setTaxRatePct(taxPct);
    setSalesTaxPct(salesPct);
    setReceiptLogoUrl(data.store.receipt_logo_url);
    setReceiptFooter(data.store.receipt_footer);
    setReceiptTaxId(data.store.receipt_tax_id);
    setTimezone(data.store.timezone);
    setHours(hydratedHours);
    setEnforceHours(enforce);
    // Baseline mirrors the snapshot() shape exactly (same key order).
    setBaseline(JSON.stringify({
      name: data.store.name, email: data.store.email,
      phone: data.store.phone, address: data.store.address,
      legalName: data.store.legal_name, ein: data.store.ein,
      businessAddress: data.store.business_address,
      taxRatePct: taxPct, salesTaxPct: salesPct,
      receiptLogoUrl: data.store.receipt_logo_url,
      receiptFooter: data.store.receipt_footer,
      receiptTaxId: data.store.receipt_tax_id,
      timezone: data.store.timezone,
      hours: hydratedHours, enforceHours: enforce,
    }));
  }, [data]);

  // The server gates the save on settings.update, so the page does
  // too (UI-STANDARDS §8: never gate on the role).
  const canEdit = hasPermission("settings", "update");

  const isDirty =
    baseline !== ""
    && snapshot(hours, enforceHours) !== baseline;
  const guard = useUnsavedGuard(isDirty && !busy && canEdit, {
    message: t("store.unsavedMessage"),
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await updateStoreInfo({
        name, email, phone, address,
        legal_name: legalName,
        ein,
        business_address: businessAddress,
        federal_tax_rate: Number(taxRatePct) / 100,
        sales_tax_rate: Number(salesTaxPct) / 100,
        receipt_logo_url: receiptLogoUrl,
        receipt_footer:   receiptFooter,
        receipt_tax_id:   receiptTaxId,
        timezone,
        store_hours: hours,
        enforce_business_hours:     enforceHours,
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin", "store-info"],
      });
      // session-status carries the zone every page renders in.
      await queryClient.invalidateQueries({
        queryKey: ["account", "session-status"],
      });
      // Edits are now the saved state — clear the dirty flag.
      setBaseline(snapshot(hours, enforceHours));
      toast({ message: t("store.saved"), tone: "success" });
    } catch (e) {
      setErr(apiErrorMessage(e, t("store.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  // Owners run the cross-store umbrella, not any single store —
  // per-store fields (name, hours, tax rate, time-clock policy)
  // live inside each connected store's own admin sign-in.  Give
  // them an "Owner umbrella" panel here with shortcuts to the
  // pages where umbrella-level settings actually exist, so the
  // tab isn't a dead-end "you're in the wrong role" message.
  if (identity?.role === "owner") {
    return (
      <Card>
        <SectionTitle>{t("store.ownerTitle")}</SectionTitle>
        <p className={styles.muted}>
          {t("store.ownerBody")}
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: space.sm,
            marginTop: space.md,
          }}
        >
          <ButtonLink to="/owner/cross-store-defaults" tone="secondary">
            {t("store.crossDefaults")}
          </ButtonLink>
          <ButtonLink to="/owner/locations" tone="secondary">
            {t("store.locations")}
          </ButtonLink>
        </div>
      </Card>
    );
  }

  if (identity?.store_id == null) {
    return (
      <Card>
        <SectionTitle>{t("store.title")}</SectionTitle>
        <p className={styles.muted}>
          {t("store.signInAsAdmin")}
        </p>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <SectionTitle>{t("store.title")}</SectionTitle>
        <Loading />
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card>
        <SectionTitle>{t("store.title")}</SectionTitle>
        <ErrorState
          message={t("store.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      </Card>
    );
  }

  return (
    // One form wraps all three cards so the operator can edit
    // anywhere and save the whole tab atomically.  Splitting the
    // form would create "did I save just this section?" doubt.
    <form
      onSubmit={onSubmit}
      style={{ display: "flex", flexDirection: "column", gap: space.lg }}
    >
      <Card>
        <SectionTitle>{t("store.title")}</SectionTitle>
        <p className={styles.slugRow}>
          {tNodes("store.slugPlan", {
            slug: <code className={styles.slug}>{data.store.slug}</code>,
            plan: planLabel(data.store.plan),
          })}
        </p>
        <div className={styles.storeGrid}>
          <Field label={t("store.name")}>
            <Input type="text" value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit} required />
          </Field>
          <Field label={t("common.email")}>
            <Input type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field label={t("common.phone")}>
            <Input type="tel" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field label={t("store.address")}>
            <Input type="text" value={address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field
            label={<>{t("store.timezone")}<InfoTip text={t("store.timezoneTip")} /></>}
            hint={data.store.timezone
              ? undefined
              : t("store.timezoneMissing")}
          >
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <Select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={!canEdit}
                style={{ flex: "1 1 auto" }}
              >
                <option value="">{t("store.timezoneNone")}</option>
                {(data.store.timezone_choices ?? []).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </Select>
              <Button
                type="button"
                tone="secondary"
                size="sm"
                disabled={!canEdit || !address.trim()}
                onClick={() => {
                  const detected = timezoneFromAddress(address);
                  if (detected) {
                    setTimezone(detected);
                    toast({
                      message: t("store.timezoneDetected", { zone: detected }),
                      tone: "success",
                    });
                  } else {
                    toast({
                      message: t("store.timezoneNotDetected"),
                      tone: "info",
                    });
                  }
                }}
              >
                {t("store.detect")}
              </Button>
            </div>
          </Field>
        </div>
      </Card>

      {/* Business / Legal is its own card — the compliance identity +
          tax config, kept apart from the day-to-day store contact
          fields above. (It used to be a bare <SectionTitle> dropped
          mid-grid, which rendered as a stray one-column cell.) */}
      <Card>
        <SectionTitle>
          {t("store.legalTitle")}
          <InfoTip text={t("store.legalTip")} />
        </SectionTitle>
        <div className={styles.storeGrid}>
          <Field label={<>{t("store.legalName")}<InfoTip text={t("store.legalNameTip")} /></>}>
            <Input type="text" value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field label={<>{EIN}<InfoTip text={t("store.einTip")} /></>}>
            <Input type="text" value={ein} placeholder={EIN_PATTERN}
              maxLength={20}
              onChange={(e) => setEin(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field label={<>{t("store.businessAddress")}<InfoTip text={t("store.businessAddressTip")} /></>}>
            <Input type="text" value={businessAddress}
              onChange={(e) => setBusinessAddress(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field label={t("store.federalTaxRate")}>
            <Input type="number" step="0.01" min="0" max="100"
              value={taxRatePct}
              onChange={(e) => setTaxRatePct(e.target.value)}
              disabled={!canEdit} />
          </Field>
          <Field
            label={<>{t("store.salesTaxRate")}<InfoTip text={t("store.salesTaxTip")} /></>}
          >
            <Input type="number" step="0.01" min="0" max="100"
              value={salesTaxPct}
              onChange={(e) => setSalesTaxPct(e.target.value)}
              disabled={!canEdit} />
          </Field>
        </div>
        {/* Receipt customization fields are intentionally hidden —
           DineroBook is a ledger, not a money-transmitter, so
           customer-facing receipts don't belong here. The columns
           still live on Store and the state hooks above still
           hydrate / send them (empty strings round-trip cleanly)
           so re-enabling is a single-file revert. See App.tsx
           lazy-import comment for the matching route hide. */}
      </Card>

      <Card>
        <SectionTitle>
          {t("store.hoursTitle")}
          <InfoTip text={t("store.hoursTip")} />
        </SectionTitle>
        <StoreHoursEditor
          hours={hours}
          onChange={setHours}
          disabled={!canEdit}
        />
        <div className={styles.enforceRow}>
          <Switch
            checked={enforceHours}
            disabled={!canEdit}
            onChange={setEnforceHours}
          >
            {t("store.blockOutside")}
            <span className={styles.enforceHint}>
              {" "}{t("store.blockOutsideHint")}
            </span>
          </Switch>
        </div>
      </Card>

      {err && <Alert tone="error">{err}</Alert>}

      {canEdit && (
        <FormActions guard={guard}>
          <Button type="submit" busy={busy} disabled={busy || !name || !isDirty}>
            {busy ? t("common.saving") : t("store.save")}
          </Button>
        </FormActions>
      )}
    </form>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const t = useT();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await changePassword({
        current_password: current,
        new_password:     next,
        confirm_password: confirm,
      });
      toast({ message: t("password.updated"), tone: "success" });
      setCurrent(""); setNext(""); setConfirm("");
    } catch (err) {
      setError(
        apiErrorMessage(err, t("password.updateFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>{t("password.title")}</SectionTitle>
      <form onSubmit={onSubmit} className={styles.passwordForm}>
        <Field label={t("password.current")}>
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label={t("password.new")}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label={t("password.confirm")}>
          <Input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
        <Button
          type="submit"
          busy={busy}
          disabled={busy || !current || !next || !confirm}
        >
          {busy ? t("common.saving") : t("password.update")}
        </Button>
      </form>
    </Card>
  );
}

// ── Store hours ───────────────────────────────────────────────

// The same in every language: the IRS name for the number, its
// shape, and the shape of a connect code.
const EIN = "EIN";
const EIN_PATTERN = "XX-XXXXXXX";
const CODE_SAMPLE = "ABCD1234";

// A stored plan in the person's language; unknown shows as stored.
const PLAN_KEYS: Record<string, MessageKey> = {
  trial: "store.planTrial", basic: "store.planBasic",
  pro: "store.planPro", inactive: "store.planInactive",
};

function planLabel(plan: string): string {
  return Object.hasOwn(PLAN_KEYS, plan) ? translate(PLAN_KEYS[plan]) : plan;
}

// Mirrors ``Services.store_hours.DEFAULT_HOURS`` so the UI can
// hydrate a complete schedule when the column is NULL.
function defaultHours(): StoreHourEntry[] {
  return [
    { day: 0, open: "09:00", close: "18:00", closed: false },
    { day: 1, open: "09:00", close: "18:00", closed: false },
    { day: 2, open: "09:00", close: "18:00", closed: false },
    { day: 3, open: "09:00", close: "18:00", closed: false },
    { day: 4, open: "09:00", close: "18:00", closed: false },
    { day: 5, open: "09:00", close: "18:00", closed: false },
    { day: 6, open: "10:00", close: "14:00", closed: true },
  ];
}

function StoreHoursEditor({
  hours, onChange, disabled,
}: {
  hours: StoreHourEntry[];
  onChange: (next: StoreHourEntry[]) => void;
  disabled: boolean;
}) {
  const t = useT();
  function setRow(idx: number, patch: Partial<StoreHourEntry>) {
    onChange(hours.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  }
  return (
    <div className={styles.hoursTable}>
      {hours.map((row, i) => (
        <Fragment key={row.day}>
          <span
            className={`${styles.hoursDay} ${row.closed ? styles.hoursClosed : ""}`}
          >
            {weekdayNameLong(row.day)}
          </span>
          <Checkbox
            checked={row.closed}
            disabled={disabled}
            onChange={(next) => setRow(i, { closed: next })}
          >
            {t("store.closed")}
          </Checkbox>
          <Input
            type="time"
            value={row.open}
            disabled={disabled || row.closed}
            className={styles.hoursTime}
            onChange={(e) => setRow(i, { open: e.target.value })}
            aria-label={t("store.openTime", { day: weekdayNameLong(row.day) })}
          />
          <span className={styles.hoursDashCell}>—</span>
          <Input
            type="time"
            value={row.close}
            disabled={disabled || row.closed}
            className={styles.hoursTime}
            onChange={(e) => setRow(i, { close: e.target.value })}
            aria-label={t("store.closeTime", { day: weekdayNameLong(row.day) })}
          />
        </Fragment>
      ))}
    </div>
  );
}


function OwnerAccessCard() {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<string | null>(null);
  const t = useT();

  async function handleRedeem(e: FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await redeemConnectCode(code.trim());
      setLinked(result.owner_name);
      setCode("");
      toast({ message: t("ownerAccess.linkedToast", { name: result.owner_name }), tone: "success" });
    } catch (err) {
      setError(apiErrorMessage(err, t("ownerAccess.redeemFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>
        {t("ownerAccess.title")}
        <InfoTip text={t("ownerAccess.tip")} />
      </SectionTitle>
      {linked && (
        <Alert tone="success">
          {tNodes("ownerAccess.linked", { name: <strong>{linked}</strong> })}
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={(e) => { void handleRedeem(e); }} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
        <Field label={t("ownerAccess.code")}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={CODE_SAMPLE}
            maxLength={8}
            style={{ fontFamily: "var(--db-font-mono)", letterSpacing: "0.15em", width: "12rem" }}
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!code.trim()}>
          {t("ownerAccess.link")}
        </Button>
      </form>
    </Card>
  );
}

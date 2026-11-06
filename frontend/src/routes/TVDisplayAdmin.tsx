import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Outlet } from "react-router-dom";

import {
  useClaimTVPairCode,
  useCreateTVDisplayCountry,
  useDeleteTVDisplayCountry,
  useRegenerateTVDisplayToken,
  useRevokeTVPairing,
  useSaveTVDisplaySettings,
  useTVDisplayOverview,
} from "../api/tvDisplay";
import { ApiError, apiErrorMessage } from "../lib/api";
import { formatTimestamp } from "../lib/datetime";
import {
  Alert, AppLink, Button, ButtonLink, Card, ConfirmDialog, CopyField,
  EmptyState, ErrorState, Field, FormActions, IconButton, Input, KpiCard,
  KpiGrid, Loading, PageHeader, PageShell, Section, Select, Switch,
  TabsBar, TabsLink, useToast,
} from "../components/ui";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./TVDisplayAdmin.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { intlLocale, t, tNodes, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/tv-display — TV Display add-on operator console.
//
// One store = one layout (enforced at the data layer). This page
// surfaces:
//   • the public URL the in-store TVs point at (with copy + rotate)
//   • the Fire TV pairing flow (operator types the code shown on the TV)
//   • the active pairing pill + unpair action
//   • settings form (title/subtitle/orientation/theme)
//   • country sections grid (links into the legacy editor for now —
//     the country editor migrates next)
//
// Strings "Public display URL", "Display settings", "Country sections"
// are referenced by tests (legacy + new). Don't rename them.

// Static country picker — same list as the legacy `_TV_COUNTRY_PICKER`
// in app.py. This list grows roughly once a year as new corridors
// come online, so inlining it here keeps the bundle simple and
// avoids an extra round-trip on page load.
const COUNTRY_PICKER: ReadonlyArray<readonly [string, string]> = [
  ["MX", "Mexico"], ["GT", "Guatemala"], ["HN", "Honduras"],
  ["SV", "El Salvador"], ["DO", "Dominican Republic"], ["NI", "Nicaragua"],
  ["CR", "Costa Rica"], ["PA", "Panama"], ["CO", "Colombia"],
  ["EC", "Ecuador"], ["PE", "Peru"], ["VE", "Venezuela"],
  ["CU", "Cuba"], ["HT", "Haiti"], ["JM", "Jamaica"],
  ["BR", "Brazil"], ["AR", "Argentina"], ["CL", "Chile"],
  ["BO", "Bolivia"], ["PY", "Paraguay"], ["UY", "Uruguay"],
  ["PH", "Philippines"], ["IN", "India"], ["PK", "Pakistan"],
  ["BD", "Bangladesh"], ["VN", "Vietnam"], ["NG", "Nigeria"],
  ["GH", "Ghana"], ["KE", "Kenya"], ["ET", "Ethiopia"],
];

const PAIR_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ234579";
const ORIENTATION_OPTIONS: { value: string; label: MessageKey }[] = [
  { value: "auto",      label: "tv.orientAuto" },
  { value: "landscape", label: "tv.orientLandscape" },
  { value: "portrait",  label: "tv.orientPortrait" },
];
// What the board itself shows when no title is set. It is board
// content (bilingual by design), not page text, so it is not
// translated.
const BOARD_DEFAULT_TITLE = "Cheapest Money Transfer";
const BOARD_SAMPLE_SUBTITLE = "Mejor Tipo de Cambio";
// Product name and a sample pairing code: the same in every language.
const TV_APP_NAME = "DineroBook TV";
const PAIR_CODE_SAMPLE = "ABC234";

// The picker shows each country in the reader's language. The name
// saved on the board stays the list's English name, as before.
function countryName(iso: string, fallback: string): string {
  try {
    return new Intl.DisplayNames([intlLocale()], { type: "region" }).of(iso) ?? fallback;
  } catch {
    return fallback;
  }
}
function flagEmoji(iso2: string): string {
  if (!iso2 || iso2.length !== 2) return "";
  const code = iso2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65)),
  );
}

// /app/tv-display — tabbed admin hub.  Layout route: this
// component renders the page chrome (title + tab bar) + the
// shared loading/error state, then `<Outlet />` for the active
// child tab.  Each tab is a child route mounted in App.tsx
// (`TVDisplayOverview`, `TVDisplayContent`, `TVDisplayDevice`).
// Tab URLs are deep-linkable.
//
// /app/tv-display (bare) redirects to /overview.
export default function TVDisplayAdmin() {
  useT(); // re-render on a language switch
  const { data, isLoading, isError, error, refetch } = useTVDisplayOverview();

  if (isLoading) {
    return (
      <PageShell gap="1.25rem">
        <PageCrumbs />
        <PageHeader title={navWord("TV display")} />
        <Loading />
      </PageShell>
    );
  }
  if (isError || !data) {
    // 409 from the addon-not-active guard surfaces here. We can't
    // redirect to /admin/subscription from React without losing the
    // session cookie path, so a clear message + a link is the
    // closest match to the legacy flash banner.
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 409) {
      return (
        <PageShell gap="1.25rem">
          <PageCrumbs />
          <PageHeader title={navWord("TV display")} />
          <p className={styles.muted}>
            {t("tv.notActive")}{" "}
            <AppLink to="/admin/subscription" className={styles.link}>
              {t("tv.turnOn")}
            </AppLink>
          </p>
        </PageShell>
      );
    }
    return (
      <PageShell gap="1.25rem">
        <PageCrumbs />
        <PageHeader title={navWord("TV display")} />
        <ErrorState
          message={`${t("tv.loadFailed")} ${apiErrorMessage(error, "")}`.trimEnd()}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader title={navWord("TV display")} />
      <TabsBar>
        <TabsLink to="/tv-display/overview">{t("tv.tabOverview")}</TabsLink>
        <TabsLink to="/tv-display/content">{t("tv.tabContent")}</TabsLink>
        <TabsLink to="/tv-display/device">{t("tv.tabDevice")}</TabsLink>
      </TabsBar>
      <Outlet />
    </PageShell>
  );
}


/** Per-tab components.  Each fetches the same overview data via
 *  the existing React-Query hook (cached at the layout route's
 *  level so the second render is instant), then renders the
 *  subset of widgets that belong to its tab.  Keeps the diff
 *  minimal: existing sub-components are unchanged. */
export function TVDisplayOverview() {
  const { data } = useTVDisplayOverview();
  const regenerateToken = useRegenerateTVDisplayToken();
  if (!data) return null;
  return (
    <>
      <Hero data={data} />
      <PublicUrlBar
        publicUrl={data.public_url}
        onRegenerate={() => regenerateToken.mutate()}
        regenerating={regenerateToken.isPending}
      />
    </>
  );
}


export function TVDisplayContent() {
  const { data } = useTVDisplayOverview();
  const createCountry = useCreateTVDisplayCountry();
  const deleteCountry = useDeleteTVDisplayCountry();
  if (!data) return null;
  return (
    <CountrySections
      countries={data.countries}
      onCreate={(payload) => createCountry.mutateAsync(payload)}
      onDelete={(id) => deleteCountry.mutateAsync(id)}
      createPending={createCountry.isPending}
      deletePending={deleteCountry.isPending}
    />
  );
}


export function TVDisplayDevice() {
  useT(); // re-render on a language switch
  const { data } = useTVDisplayOverview();
  const saveSettings = useSaveTVDisplaySettings();
  const claimPair = useClaimTVPairCode();
  const revokePair = useRevokeTVPairing();
  if (!data) return null;
  return (
    <>
      <PairFireTV
        activePairing={data.active_pairing}
        onClaim={(code) => claimPair.mutateAsync(code)}
        onRevoke={(id) => revokePair.mutateAsync(id)}
        claimError={claimPair.error ? apiErrorMessage(claimPair.error, t("tv.pairFailed"), { anyError: true }) : null}
        claimPending={claimPair.isPending}
        revokePending={revokePair.isPending}
      />
      <SettingsAndStatsGrid
        data={data}
        onSave={(payload) => saveSettings.mutateAsync(payload)}
        savePending={saveSettings.isPending}
      />
    </>
  );
}


// ── Hero ──────────────────────────────────────────────────────

function Hero({
  data,
}: {
  data: import("../api/tvDisplay").TVDisplayOverviewResponse;
}) {
  useT(); // re-render on a language switch
  const lastEdited = data.last_updated_at
    ? formatTimestamp(data.last_updated_at)
    : null;
  return (
    <section className={styles.hero}>
      <div>
        <div className={styles.eyebrow}>{t("tv.eyebrow")}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 className={styles.heroTitle}>{data.title || BOARD_DEFAULT_TITLE}</h1>
          <span className={styles.statusPill}>
            <span className={styles.statusDot} />
            {t("tv.live")}
          </span>
        </div>
        <div className={styles.heroMeta}>
          {tNodes("tv.heroMeta", { one: <b>{t("tv.oneLayout")}</b> })}
          {lastEdited ? (
            <> {tNodes("tv.lastEdited", { when: <b>{lastEdited}</b> })}</>
          ) : null}
        </div>
      </div>
      <div>
        <ButtonLink
          href={data.public_url}
          target="_blank"
          rel="noopener"
        >
          {t("tv.openTv")}
        </ButtonLink>
      </div>
    </section>
  );
}


// ── Public URL bar + regenerate-token panel ─────────────────────

function PublicUrlBar({
  publicUrl, onRegenerate, regenerating,
}: {
  publicUrl: string;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  useT(); // re-render on a language switch
  const [showRegenForm, setShowRegenForm] = useState(false);
  const [confirmingRegen, setConfirmingRegen] = useState(false);

  function doRegenerate() {
    setConfirmingRegen(false);
    onRegenerate();
  }

  return (
    <section style={{ marginTop: 18 }}>
      <CopyField
        label={t("tv.publicUrl")}
        value={publicUrl}
        actions={(
          <ButtonLink
            href={publicUrl}
            tone="secondary"
            target="_blank"
            rel="noopener"
          >
            {t("tv.open")}
          </ButtonLink>
        )}
      />
      <details
        style={{ marginTop: 8 }}
        open={showRegenForm}
        onToggle={(e) => setShowRegenForm((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className={styles.detailsSummary}>
          {t("tv.regenSummary")}
        </summary>
        <div className={styles.regenPanel}>
          <p className={styles.regenCopy}>
            {t("tv.regenCopy")}
          </p>
          <Button
            tone="danger" size="sm"
            perm="settings.update"
            onClick={() => setConfirmingRegen(true)}
            busy={regenerating}
            disabled={regenerating}
          >
            {regenerating ? t("tv.regenerating") : t("tv.regenerate")}
          </Button>
        </div>
      </details>

      <ConfirmDialog
        open={confirmingRegen}
        title={t("tv.rotateTitle")}
        message={t("tv.rotateMessage")}
        confirmLabel={t("tv.rotate")}
        confirmTone="danger"
        busy={regenerating}
        onConfirm={doRegenerate}
        onCancel={() => setConfirmingRegen(false)}
      />
    </section>
  );
}


// ── Pair-a-Fire-TV ──────────────────────────────────────────

function PairFireTV({
  activePairing, onClaim, onRevoke,
  claimError, claimPending, revokePending,
}: {
  activePairing: import("../api/tvDisplay").TVPairingSummary | null;
  onClaim: (code: string) => Promise<unknown>;
  onRevoke: (id: number) => Promise<unknown>;
  claimError: string | null;
  claimPending: boolean;
  revokePending: boolean;
}) {
  useT(); // re-render on a language switch
  const [code, setCode] = useState("");
  const toast = useToast();
  const [flash, setFlash] = useState<string | null>(null);
  const [pendingUnpair, setPendingUnpair] = useState<number | null>(null);
  const [unpairBusy, setUnpairBusy] = useState(false);

  function normaliseInput(raw: string): string {
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  }

  async function submitClaim(e: FormEvent) {
    e.preventDefault();
    setFlash(null);
    try {
      await onClaim(code);
      setCode("");
      toast({
        message: t("tv.paired"),
        tone: "success",
      });
    } catch (err) {
      const msg = (err instanceof ApiError && typeof err.body === "object" && err.body !== null
        ? (err.body as { detail?: string }).detail
        : null) ?? t("tv.codeNotFound");
      setFlash(msg);
    }
  }

  async function doUnpair() {
    if (pendingUnpair == null) return;
    setFlash(null);
    setUnpairBusy(true);
    try {
      await onRevoke(pendingUnpair);
      setPendingUnpair(null);
      toast({
        message: t("tv.unpaired"),
        tone: "success",
      });
    } finally {
      setUnpairBusy(false);
    }
  }

  // Claim button is enabled only when the input has 6 valid chars.
  const codeValid = code.length === 6
    && [...code].every((c) => PAIR_CODE_ALPHABET.includes(c));

  return (
    <section className={styles.pairWrapper}>
      <div className={styles.pairBox}>
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <h3 className={styles.pairTitle}>{t("tv.pairTitle")}</h3>
          <p className={styles.pairCopy}>
            {tNodes("tv.pairCopy", { app: <b>{TV_APP_NAME}</b> })}
          </p>
        </div>
        <form onSubmit={submitClaim} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(normaliseInput(e.target.value))}
            maxLength={8}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            placeholder={PAIR_CODE_SAMPLE}
            aria-label={t("tv.codeLabel")}
            className={styles.pairInput}
          />
          <Button
            type="submit"
            perm="settings.update"
            busy={claimPending}
            disabled={!codeValid || claimPending}
          >
            {claimPending ? t("tv.pairing") : t("tv.pair")}
          </Button>
        </form>
      </div>
      {flash && <Alert tone="error">{flash}</Alert>}
      {claimError && !flash && <Alert tone="error">{claimError}</Alert>}
      {activePairing && (
        <div className={styles.activePairing}>
          <span className={styles.activeDot} aria-hidden="true" />
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <b>
              {activePairing.device_label
                ? t("tv.pairedAs", { label: activePairing.device_label })
                : t("tv.pairedPlain")}
            </b>
            <div className={styles.mutedSmall}>
              {t("tv.pairedSeen", {
                paired: formatTimestamp(activePairing.paired_at),
                seen: formatTimestamp(activePairing.last_seen_at),
              })}
            </div>
          </div>
          <Button
            tone="danger" size="sm"
            perm="settings.update"
            onClick={() => setPendingUnpair(activePairing.id)}
            busy={revokePending}
            disabled={revokePending}
          >
            {revokePending ? t("tv.unpairing") : t("tv.unpairThis")}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingUnpair != null}
        title={t("tv.unpairTitle")}
        message={t("tv.unpairMessage")}
        confirmLabel={t("tv.unpair")}
        confirmTone="danger"
        busy={unpairBusy}
        onConfirm={() => { void doUnpair(); }}
        onCancel={() => setPendingUnpair(null)}
      />
    </section>
  );
}


// ── Settings + at-a-glance grid ──────────────────────────────

function SettingsAndStatsGrid({
  data, onSave, savePending,
}: {
  data: import("../api/tvDisplay").TVDisplayOverviewResponse;
  onSave: (payload: import("../api/tvDisplay").TVDisplaySettingsUpdate) => Promise<unknown>;
  savePending: boolean;
}) {
  const saved = useMemo(() => ({
    title:       data.title,
    subtitle:    data.subtitle,
    orientation: data.orientation || "auto",
    theme:       data.theme || "light",
  }), [data.title, data.subtitle, data.orientation, data.theme]);
  useT(); // re-render on a language switch
  const [draft, setDraft] = useState(saved);
  const toast = useToast();

  // Re-sync if the upstream data changes (e.g. after a save invalidation).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-hydrate local editable draft from server-fetched TV display config after save invalidation
    setDraft(saved);
  }, [saved]);

  // The saved settings are the baseline, so a save clears it once the
  // refreshed config arrives.
  const guard = useUnsavedGuard(
    JSON.stringify(draft) !== JSON.stringify(saved) && !savePending,
    { message: t("tv.unsaved") },
  );

  const stats = useMemo(() => {
    let totalBanks = 0, totalRates = 0;
    for (const c of data.countries) {
      totalBanks += c.bank_count;
      totalRates += c.rate_count;
    }
    return { totalBanks, totalRates };
  }, [data.countries]);

  const toastApiError = useApiErrorToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await onSave(draft);
    } catch (err) {
      // A refused save used to reject unhandled: no message, and the
      // edits looked saved.
      toastApiError(err, t("tv.saveFailed"));
      return;
    }
    toast({ message: t("tv.saved"), tone: "success" });
  }

  return (
    <div className={styles.gridTwoOne}>
      <Card>
        <Section title={t("tv.settings")}>
          <form onSubmit={submit}>
            <div className={styles.fieldGrid}>
              <Field label={t("tv.titleField")}>
                <Input
                  type="text"
                  value={draft.title}
                  maxLength={120}
                  placeholder={BOARD_DEFAULT_TITLE}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                />
              </Field>
              <Field label={t("tv.subtitleField")}>
                <Input
                  type="text"
                  value={draft.subtitle}
                  maxLength={120}
                  placeholder={BOARD_SAMPLE_SUBTITLE}
                  onChange={(e) => setDraft((d) => ({ ...d, subtitle: e.target.value }))}
                />
              </Field>
              <Field label={t("tv.orientation")}>
                <Select
                  value={draft.orientation}
                  onChange={(e) => setDraft((d) => ({ ...d, orientation: e.target.value }))}
                >
                  {ORIENTATION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{t(o.label)}</option>
                  ))}
                </Select>
              </Field>
              <Field
                label={t("tv.theme")}
                hint={t("tv.themeHint")}
              >
                <Switch
                  checked={draft.theme === "dark"}
                  onChange={(on) =>
                    setDraft((d) => ({ ...d, theme: on ? "dark" : "light" }))
                  }
                >
                  {draft.theme === "dark" ? t("tv.dark") : t("tv.light")}
                </Switch>
              </Field>
            </div>
            <FormActions guard={guard}>
              <Button
                type="submit"
                busy={savePending}
                disabled={savePending}
              >
                {savePending ? t("common.saving") : t("tv.saveSettings")}
              </Button>
            </FormActions>
          </form>
        </Section>
      </Card>
      <Card>
        <Section title={t("tv.glance")}>
          <KpiGrid minWidth="9rem">
            <KpiCard label={t("tv.countrySections")} value={data.countries.length} />
            <KpiCard label={t("tv.payoutBanks")} value={stats.totalBanks} />
            <KpiCard label={t("tv.rateCells")} value={stats.totalRates} />
            <KpiCard label={t("tv.subscription")} value={t("tv.price")} tone="neon" colorValue />
          </KpiGrid>
        </Section>
      </Card>
    </div>
  );
}


// ── Country sections ─────────────────────────────────────────

function CountrySections({
  countries, onCreate, onDelete, createPending, deletePending,
}: {
  countries: import("../api/tvDisplay").TVDisplayCountryStat[];
  onCreate: (payload: import("../api/tvDisplay").TVDisplayCreateCountryRequest) => Promise<import("../api/tvDisplay").TVDisplayCreateCountryResponse>;
  onDelete: (id: number) => Promise<unknown>;
  createPending: boolean;
  deletePending: boolean;
}) {
  useT(); // re-render on a language switch
  const [showAdd, setShowAdd] = useState(false);
  const [picker, setPicker] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] =
    useState<{ id: number; name: string } | null>(null);

  async function addCountry(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const match = COUNTRY_PICKER.find(([iso]) => iso === picker);
    if (!match) {
      setCreateError(t("tv.pickCountry"));
      return;
    }
    try {
      const created = await onCreate({
        country_name: match[1],
        country_code: match[0],
      });
      // Straight on to the country editor so the operator can add
      // banks + rates immediately.
      window.location.assign(`/tv-display/countries/${created.id}`);
    } catch (err) {
      setCreateError(apiErrorMessage(err, t("tv.createFailed")));
    }
  }

  async function doRemove() {
    if (!pendingRemove) return;
    await onDelete(pendingRemove.id);
    setPendingRemove(null);
  }

  return (
    <>
      <div className={styles.countriesHead}>
        <div>
          <h2 className={styles.sectionTitle}>{t("tv.countrySections")}</h2>
          <div className={styles.mutedSmall}>
            {t("tv.sectionsHint")}
          </div>
        </div>
      </div>
      {countries.length === 0 && (
        <EmptyState
          title={t("tv.noSections")}
          body={t("tv.noSectionsBody")}
        />
      )}
      <div className={styles.countryGrid}>
        {countries.map((c) => (
          <div key={c.id} className={styles.countryCardWrapper}>
            <AppLink
              to={`/tv-display/countries/${c.id}`}
              reloadDocument
              className={styles.countryCardLink}
            >
              <div className={c.country_code ? styles.flagBox : `${styles.flagBox} ${styles.flagBoxEmpty}`}>
                {c.country_code ? flagEmoji(c.country_code) : "—"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={styles.countryName}>
                  {c.country_name}
                  {c.country_code && <span className={styles.countryIso}>{c.country_code}</span>}
                </div>
                <div className={styles.countryStats}>
                  {tNodes("tv.countryStats", {
                    banks: <span className={styles.countryStatNum}>{c.bank_count}</span>,
                    rates: <span className={styles.countryStatNum}>{c.rate_count}</span>,
                  })}
                </div>
              </div>
              <div className={styles.countryArrow} aria-hidden="true">→</div>
            </AppLink>
            {/* Absolute positioning lives in style here (vs the
                old `.countryDeleteButton` class) so the kit
                IconButton can own the visual treatment. */}
            <IconButton
              tone="neutral" size="sm"
              onClick={(e) => { e.preventDefault(); setPendingRemove({ id: c.id, name: c.country_name }); }}
              disabled={deletePending}
              title={t("tv.remove", { name: c.country_name })}
              style={{ position: "absolute", top: 6, right: 6 }}
            >
              ×
            </IconButton>
          </div>
        ))}
        <details
          className={styles.addCountry}
          open={showAdd}
          onToggle={(e) => setShowAdd((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className={styles.addCountrySummary}>
            <div className={styles.plusIcon}>+</div>
            <div style={{ flex: 1 }}>
              <div className={styles.countryName} style={{ color: "var(--db-text-muted)" }}>{t("tv.addCountry")}</div>
              <div className={styles.countryStats}>
                {t("tv.addCountryHint")}
              </div>
            </div>
          </summary>
          <form onSubmit={addCountry} style={{ padding: 18 }}>
            <Field label={t("tv.countryField")} style={{ maxWidth: 460 }}>
              <Select
                value={picker}
                required
                onChange={(e) => setPicker(e.target.value)}
              >
                <option value="">{t("tv.pickPlaceholder")}</option>
                {COUNTRY_PICKER.map(([iso, name]) => (
                  <option key={iso} value={iso}>{countryName(iso, name)}</option>
                ))}
              </Select>
            </Field>
            {createError && <Alert tone="error">{createError}</Alert>}
            <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
              <Button
                type="submit"
                busy={createPending}
                disabled={createPending}
              >
                {createPending ? t("tv.adding") : t("tv.addCountryButton")}
              </Button>
            </div>
          </form>
        </details>
      </div>

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("tv.removeTitle")}
        message={t("tv.removeMessage", { name: pendingRemove?.name ?? t("tv.thisCountry") })}
        confirmLabel={t("tv.removeButton")}
        confirmTone="danger"
        busy={deletePending}
        onConfirm={() => { void doRemove(); }}
        onCancel={() => setPendingRemove(null)}
      />
    </>
  );
}

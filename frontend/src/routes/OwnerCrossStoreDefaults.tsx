import { useMemo, useState, type FormEvent } from "react";

import {
  applyCrossStoreDefaults, useOwnerLocations,
  type OwnerCrossStoreDefaultsBody, type OwnerCrossStoreResultRow,
} from "../api/owner";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Button, Card, Checkbox, Empty, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, Section, Select, Switch,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import { BulkResultsCard } from "../components/BulkResultsCard";
import { useStoreSelection } from "../lib/useStoreSelection";
import styles from "./OwnerCrossStoreDefaults.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

const TZ_EXAMPLE = "America/Chicago";

// /app/owner/cross-store-defaults — owner pushes the same
// field defaults (fed-tax-rate, timezone, business-hours
// toggles, contact info) to every store they pick. Mirrors
// the bulk-add-user UX so the result table reads the same.
//
// The form picks fields via per-field "Apply" checkboxes —
// fields without a checked box are omitted from the request,
// keeping the per-store row untouched (different from the
// per-store settings form where every save replaces every
// editable field).

const TIMEZONE_CHOICES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Mexico_City",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Buenos_Aires",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Madrid",
  "Asia/Manila",
  "Asia/Karachi",
  "UTC",
];

export default function OwnerCrossStoreDefaults() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const { data: locations, isLoading, isError, refetch } =
    useOwnerLocations("month", "");

  const [results, setResults] =
    useState<OwnerCrossStoreResultRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Per-field "apply this one" toggles + values.
  const [applyTz, setApplyTz]                 = useState(false);
  const [tz, setTz]                           = useState("America/Chicago");
  const [applyFedTax, setApplyFedTax]         = useState(false);
  const [fedTaxPct, setFedTaxPct]             = useState("1.00");
  const [applyEnforceHours, setApplyEnforceHours] = useState(false);
  const [enforceHours, setEnforceHours]       = useState(false);
  const [applyPasskey, setApplyPasskey]       = useState(false);
  const [passkeyOn, setPasskeyOn]             = useState(false);
  const [applyPhone, setApplyPhone]           = useState(false);
  const [phone, setPhone]                     = useState("");
  const [applyAddress, setApplyAddress]       = useState(false);
  const [address, setAddress]                 = useState("");

  const allStoreIds = useMemo(
    () => locations?.rows.map((r) => r.store_id) ?? [],
    [locations],
  );
  const {
    selected: storeIds, isSelected, toggle: toggleStore, toggleAll, allSelected,
  } = useStoreSelection(allStoreIds);

  const { dirty, markSaved } = useDirtyBaseline({
    applyTz, tz, applyFedTax, fedTaxPct, applyEnforceHours, enforceHours,
    applyPasskey, passkeyOn, applyPhone, phone, applyAddress, address,
  });
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("defaults.unsaved"),
  });

  if (!identity || (identity.role !== "owner"
                    && identity.role !== "superadmin")) {
    return (
      <PageShell>
        <PageHeader title={navWord("Cross-store defaults")} />
        <Empty>{t("bulkAdd.ownerOnly")}</Empty>
      </PageShell>
    );
  }

  const anyFieldChecked = applyTz || applyFedTax || applyEnforceHours
                          || applyPasskey || applyPhone || applyAddress;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setResults(null); setBusy(true);
    try {
      const body: OwnerCrossStoreDefaultsBody = { store_ids: storeIds };
      if (applyTz)             body.timezone               = tz;
      if (applyFedTax) {
        const v = Number(fedTaxPct);
        if (!Number.isFinite(v) || v < 0 || v > 100) {
          throw new Error(t("defaults.taxRange"));
        }
        body.federal_tax_rate = v / 100;
      }
      if (applyEnforceHours)   body.enforce_business_hours    = enforceHours;
      if (applyPasskey)        body.timeclock_require_passkey = passkeyOn;
      if (applyPhone)          body.phone                     = phone;
      if (applyAddress)        body.address                   = address;
      const out = await applyCrossStoreDefaults(body);
      setResults(out.results);
      markSaved();
    } catch (e2) {
      setErr(apiErrorMessage(
        e2, t("defaults.applyFailed"), { anyError: true },
      ));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Cross-store defaults")}
        subtitle={t("defaults.subtitle")}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("bulkAdd.storesLoadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {locations && locations.rows.length === 0 && (
        <Empty>
          {tNodes("bulkAdd.noStores", {
            link: <AppLink to="/owner/connect">{navWord("Connect a store")}</AppLink>,
          })}
        </Empty>
      )}

      {locations && locations.rows.length > 0 && (
        <form onSubmit={onSubmit}>
          <Card>
            <Section title={t("defaults.fieldsToPush")}>
              <Checkbox checked={applyTz} onChange={setApplyTz}>
                {t("defaults.timezone")}
                <span className={styles.fieldHint}>
                  {" "}{tNodes("defaults.timezoneHint", { example: <code>{TZ_EXAMPLE}</code> })}
                </span>
              </Checkbox>
              {applyTz && (
                <Field label={t("defaults.timezone")}>
                  <Select
                    value={tz}
                    onChange={(e) => setTz(e.target.value)}
                  >
                    {TIMEZONE_CHOICES.map((z) => (
                      <option key={z} value={z}>{z}</option>
                    ))}
                  </Select>
                </Field>
              )}

              <Checkbox checked={applyFedTax} onChange={setApplyFedTax}>
                {t("defaults.fedTax")}
                <span className={styles.fieldHint}>{" "}{t("defaults.fedTaxHint")}</span>
              </Checkbox>
              {applyFedTax && (
                <Field label={t("defaults.fedTaxPct")}>
                  <Input
                    type="number" min="0" max="100" step="0.01"
                    value={fedTaxPct}
                    onChange={(e) => setFedTaxPct(e.target.value)}
                  />
                </Field>
              )}

              <Checkbox checked={applyEnforceHours} onChange={setApplyEnforceHours}>
                {t("defaults.blockHours")}
              </Checkbox>
              {applyEnforceHours && (
                <Field label={t("defaults.state")} hint={t("defaults.blockHoursHint")}>
                  <Switch checked={enforceHours} onChange={setEnforceHours}>
                    {enforceHours ? t("defaults.on") : t("defaults.offDefault")}
                  </Switch>
                </Field>
              )}

              <Checkbox checked={applyPasskey} onChange={setApplyPasskey}>
                {t("defaults.requirePasskey")}
              </Checkbox>
              {applyPasskey && (
                <Field label={t("defaults.state")} hint={t("defaults.passkeyHint")}>
                  <Switch checked={passkeyOn} onChange={setPasskeyOn}>
                    {passkeyOn ? t("defaults.on") : t("defaults.offDefault")}
                  </Switch>
                </Field>
              )}

              <div className={styles.fieldGrid}>
                <div>
                  <Checkbox checked={applyPhone} onChange={setApplyPhone}>
                    {t("defaults.phone")}
                  </Checkbox>
                  {applyPhone && (
                    <Field label={t("defaults.phone")}>
                      <Input
                        type="tel" value={phone} maxLength={40}
                        onChange={(e) => setPhone(e.target.value)}
                      />
                    </Field>
                  )}
                </div>
                <div>
                  <Checkbox checked={applyAddress} onChange={setApplyAddress}>
                    {t("defaults.address")}
                  </Checkbox>
                  {applyAddress && (
                    <Field label={t("defaults.address")}>
                      <Input
                        type="text" value={address} maxLength={255}
                        onChange={(e) => setAddress(e.target.value)}
                      />
                    </Field>
                  )}
                </div>
              </div>
            </Section>

            <Section title={t("bulkAdd.applyTo")}>
              <div className={styles.toolbar}>
                <Button
                  type="button" tone="secondary" size="sm"
                  onClick={toggleAll}
                >
                  {allSelected ? t("bulkAdd.clearAll") : t("bulkAdd.selectAll")}
                </Button>
                <span className={styles.toolbarCount}>
                  {t("bulkAdd.selectedOf", { count: storeIds.length, total: allStoreIds.length })}
                </span>
              </div>
              <ul className={styles.storeList}>
                {locations.rows.map((s) => (
                  <li key={s.store_id}>
                    <Checkbox
                      checked={isSelected(s.store_id)}
                      onChange={() => toggleStore(s.store_id)}
                    >
                      <span className={styles.storeName}>{s.store_name}</span>
                      <span className={styles.storeSlug}>{s.store_slug}</span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            </Section>

            {err && <Alert tone="error">{err}</Alert>}

            <FormActions guard={guard}>
              <Button
                type="submit"
                busy={busy}
                disabled={
                  busy
                  || storeIds.length === 0
                  || !anyFieldChecked
                }
              >
                {busy
                  ? t("defaults.applying")
                  : tn("defaults.applyTo", storeIds.length)}
              </Button>
            </FormActions>
          </Card>
        </form>
      )}

      {results && <BulkResultsCard rows={results} />}
    </PageShell>
  );
}


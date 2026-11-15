import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  saveCheckSettings, useCheckSettings, type CheckSettings, switchOffCheckDevice, useCheckDevice,
} from "../api/checkCashing";
import { FeeFields, type FeeKind } from "../components/CheckCashingFields";
import { DeskColumns, DeskForm, DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Alert, Button, Card, ConfirmDialog, ErrorState, Field, FormActions, Input, Loading, MoneyInput,
  PageHeader, SectionTitle, Select, Switch, useToast,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/datetime";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./CheckCashing.module.css";

// Check cashing app → Settings (/app/check-cashing/settings).
// The store's default fee, the optional base charge for small checks,
// what an expired ID does, an optional daily limit per customer, and
// the business details a Currency Transaction Report needs.
// "Manage check cashing" only.

interface Form {
  fee_kind: FeeKind;
  fee_value: number;
  base_on: boolean;
  base_charge: number;
  base_under: number;
  expired_id_mode: "warn" | "block";
  limit_on: boolean;
  limit: number;
  // The business as FinCEN knows it (CTR, PR 6a).
  ctr: CtrFiler;
  gto_enabled: boolean;
}

const CTR_FIELDS = [
  "legal_name", "ein", "street", "city", "state", "zip_code",
  "contact_name", "contact_phone", "msb_registration",
] as const;
type CtrFiler = Record<(typeof CTR_FIELDS)[number], string>;

function fromSettings(s: CheckSettings): Form {
  return {
    fee_kind: s.default_fee_kind,
    fee_value: s.default_fee_value,
    base_on: s.base_charge != null,
    base_charge: s.base_charge ?? 0,
    base_under: s.base_charge_under ?? 0,
    expired_id_mode: s.expired_id_mode,
    limit_on: s.daily_limit != null,
    limit: s.daily_limit ?? 0,
    ctr: Object.fromEntries(CTR_FIELDS.map((f) => [f, s[f]])) as CtrFiler,
    gto_enabled: s.gto_enabled,
  };
}

export default function CheckCashingSettings() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const settings = useCheckSettings();
  const [form, setForm] = useState<Form | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const next = fromSettings(settings.data);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable form + dirty baseline from the fetched settings
    setForm(next);
    setBaseline(JSON.stringify(next));
  }, [settings.data]);

  const guard = useUnsavedGuard(form != null && JSON.stringify(form) !== baseline && !busy, {
    message: t("checkCashing.unsavedSettings"),
  });
  const title = navWord("Settings");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    setBusy(true);
    try {
      const saved = await saveCheckSettings({
        default_fee_kind: form.fee_kind,
        default_fee_value: form.fee_value,
        base_charge: form.base_on ? form.base_charge : null,
        base_charge_under: form.base_on ? form.base_under : null,
        expired_id_mode: form.expired_id_mode,
        daily_limit: form.limit_on ? form.limit : null,
        ...Object.fromEntries(CTR_FIELDS.map((f) => [f, form.ctr[f].trim()])) as CtrFiler,
        gto_enabled: form.gto_enabled,
      });
      const next = fromSettings(saved);
      setForm(next);
      setBaseline(JSON.stringify(next));
      void queryClient.invalidateQueries({ queryKey: ["check-cashing", "settings"] });
      toast({ message: t("checkCashing.settingsSaved"), tone: "success" });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (settings.isError && !settings.data) {
    return (
      <DeskPage>
        <PageCrumbs />
        <PageHeader title={title} />
        <ErrorState
          message={apiErrorMessage(settings.error, t("checkCashing.loadFailed"))}
          onRetry={() => void settings.refetch()}
          busy={settings.isFetching}
        />
      </DeskPage>
    );
  }
  if (!form) {
    return <DeskPage><Loading /></DeskPage>;
  }

  const baseInvalid = form.base_on && (form.base_charge <= 0 || form.base_under <= 0);
  const limitInvalid = form.limit_on && form.limit <= 0;
  const setCtr = (key: keyof CtrFiler, value: string) =>
    setForm({ ...form, ctr: { ...form.ctr, [key]: value } });
  const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);
  const einInvalid = form.ctr.ein !== "" && form.ctr.ein.length !== 9;
  const zipInvalid = form.ctr.zip_code !== "" && ![5, 9].includes(form.ctr.zip_code.length);
  const stateInvalid = form.ctr.state !== "" && form.ctr.state.length !== 2;

  return (
    <DeskPage>
      <PageCrumbs />
      <PageHeader title={title} subtitle={t("checkCashing.settingsSubtitle")} />

      <DeskColumns>
        <DeskForm onSubmit={onSubmit}>
          <DeskPane className="ds-form">
          <Card>
            <SectionTitle>{t("checkCashing.defaultFee")}</SectionTitle>
            <p className={styles.note}>{t("checkCashing.defaultFeeHint")}</p>
            <div className={styles.fieldGrid}>
              <FeeFields
                label={t("checkCashing.feeType")}
                allowNone={false}
                kind={form.fee_kind}
                value={form.fee_value}
                onChange={(kind, value) => setForm({
                  ...form, fee_kind: kind ?? "percent", fee_value: value ?? 0,
                })}
              />
            </div>
          </Card>

          <Card>
            <SectionTitle>{t("checkCashing.baseCharge")}</SectionTitle>
            <Switch
              checked={form.base_on}
              onChange={(on) => setForm({ ...form, base_on: on })}
            >
              {t("checkCashing.baseChargeOn")}
            </Switch>
            {form.base_on && (
              <div className={styles.fieldGrid}>
                <MoneyInput
                  label={t("checkCashing.baseChargeAmount")}
                  value={form.base_charge}
                  onChange={(v) => setForm({ ...form, base_charge: v })}
                />
                <MoneyInput
                  label={t("checkCashing.baseChargeUnder")}
                  value={form.base_under}
                  onChange={(v) => setForm({ ...form, base_under: v })}
                />
                <p className={`${styles.note} ${styles.full}`}>
                  {t("checkCashing.baseChargeHint")}
                </p>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>{t("checkCashing.expiredIdTitle")}</SectionTitle>
            <Field label={t("checkCashing.expiredId")} hint={t("checkCashing.expiredIdHint")}>
              <Select
                value={form.expired_id_mode}
                onChange={(e) => setForm({
                  ...form, expired_id_mode: e.target.value as Form["expired_id_mode"],
                })}
              >
                <option value="warn">{t("checkCashing.expiredWarn")}</option>
                <option value="block">{t("checkCashing.expiredBlock")}</option>
              </Select>
            </Field>
          </Card>

          <Card>
            <SectionTitle>{t("checkCashing.dailyLimit")}</SectionTitle>
            <Switch
              checked={form.limit_on}
              onChange={(on) => setForm({ ...form, limit_on: on })}
            >
              {t("checkCashing.dailyLimitOn")}
            </Switch>
            {form.limit_on && (
              <div className={styles.fieldGrid}>
                <MoneyInput
                  label={t("checkCashing.dailyLimit")}
                  value={form.limit}
                  onChange={(v) => setForm({ ...form, limit: v })}
                />
              </div>
            )}
            <p className={styles.note}>{t("checkCashing.dailyLimitHint")}</p>
          </Card>

          <Card>
            <SectionTitle>{t("checkCashing.ctrSettings")}</SectionTitle>
            <p className={styles.note}>{t("checkCashing.ctrSettingsHint")}</p>
            <div className={styles.fieldGrid}>
              <Field label={t("checkCashing.legalName")}>
                <Input
                  type="text" maxLength={150} value={form.ctr.legal_name}
                  onChange={(e) => setCtr("legal_name", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.ein")} error={einInvalid ? t("checkCashing.einInvalid") : undefined}>
                <Input
                  type="text" inputMode="numeric" value={form.ctr.ein}
                  onChange={(e) => setCtr("ein", digits(e.target.value, 9))}
                />
              </Field>
              <Field label={t("checkCashing.msbRegistration")}>
                <Input
                  type="text" maxLength={30} value={form.ctr.msb_registration}
                  onChange={(e) => setCtr("msb_registration", e.target.value)}
                />
              </Field>
              <div className={styles.full}>
                <Field label={t("checkCashing.street")}>
                  <Input
                    type="text" maxLength={100} value={form.ctr.street}
                    onChange={(e) => setCtr("street", e.target.value)}
                  />
                </Field>
              </div>
              <Field label={t("checkCashing.city")}>
                <Input
                  type="text" maxLength={50} value={form.ctr.city}
                  onChange={(e) => setCtr("city", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.state")} error={stateInvalid ? t("checkCashing.stateInvalid") : undefined}>
                <Input
                  type="text" maxLength={2} value={form.ctr.state}
                  onChange={(e) => setCtr("state", e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
                />
              </Field>
              <Field label={t("checkCashing.zip")} error={zipInvalid ? t("checkCashing.zipInvalid") : undefined}>
                <Input
                  type="text" inputMode="numeric" value={form.ctr.zip_code}
                  onChange={(e) => setCtr("zip_code", digits(e.target.value, 9))}
                />
              </Field>
              <Field label={t("checkCashing.contactName")}>
                <Input
                  type="text" maxLength={100} value={form.ctr.contact_name}
                  onChange={(e) => setCtr("contact_name", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.contactPhone")}>
                <Input
                  type="tel" inputMode="numeric" value={form.ctr.contact_phone}
                  onChange={(e) => setCtr("contact_phone", digits(e.target.value, 16))}
                />
              </Field>
            </div>
            <Switch
              checked={form.gto_enabled}
              onChange={(on) => setForm({ ...form, gto_enabled: on })}
            >
              {t("checkCashing.gtoOn")}
            </Switch>
            <p className={styles.note}>{t("checkCashing.gtoHint")}</p>
          </Card>

          </DeskPane>

          {error && <Alert tone="error">{error}</Alert>}

          <FormActions guard={guard}>
            <Button type="submit" busy={busy} disabled={busy || baseInvalid || limitInvalid || einInvalid || zipInvalid || stateInvalid}>
              {t("checkCashing.saveSettings")}
            </Button>
          </FormActions>
        </DeskForm>
        <div>
          <ThisComputer />
        </div>
      </DeskColumns>
    </DeskPage>
  );
}

/** The store's check cashing computer (this one: the page only opens
 *  there) and switching it off. Moving it is done from the new
 *  computer's lock screen. */
function ThisComputer() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const device = useCheckDevice();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = device.data;

  async function switchOff() {
    setBusy(true); setError(null);
    try {
      await switchOffCheckDevice();
      setConfirming(false);
      toast({ message: t("checkCashing.switchedOff"), tone: "success" });
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>{t("checkCashing.computerTitle")}</SectionTitle>
      {d && (
        <p className={styles.note}>
          {t("checkCashing.computerLine", {
            name: d.name, by: d.activated_by || "—",
            when: d.activated_at ? formatDateTime(d.activated_at) : "—",
          })}
        </p>
      )}
      <p className={styles.note}>{t("checkCashing.computerHint")}</p>
      <Button type="button" tone="danger" size="sm" onClick={() => { setError(null); setConfirming(true); }}>
        {t("checkCashing.switchOff")}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={t("checkCashing.switchOffTitle")}
        message={t("checkCashing.switchOffMessage", { name: d?.name ?? "" })}
        confirmLabel={t("checkCashing.switchOff")}
        confirmTone="danger"
        busy={busy}
        error={error}
        onConfirm={() => { void switchOff(); }}
        onCancel={() => { setConfirming(false); setError(null); }}
      />
    </Card>
  );
}

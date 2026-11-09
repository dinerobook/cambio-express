import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  saveCheckSettings, useCheckSettings, type CheckSettings, switchOffCheckDevice, useCheckDevice,
} from "../api/checkCashing";
import { FeeFields, type FeeKind } from "../components/CheckCashingFields";
import { DeskColumns, DeskForm, DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Alert, Button, Card, ConfirmDialog, ErrorState, Field, FormActions, Loading, MoneyInput,
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
// what an expired ID does, and an optional daily limit per customer.
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
}

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

          </DeskPane>

          {error && <Alert tone="error">{error}</Alert>}

          <FormActions guard={guard}>
            <Button type="submit" busy={busy} disabled={busy || baseInvalid || limitInvalid}>
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

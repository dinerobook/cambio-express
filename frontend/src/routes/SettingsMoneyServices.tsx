import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  updateStoreInfo, useStoreInfo, type MTCompanyEntry,
} from "../api/account";
import { TRANSFER_CHOICES_KEY } from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { hasPermission } from "../lib/permissions";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  Alert, Button, Card, ErrorState, FormActions, InfoTip, Input, Loading,
  MoneyInput, Pill, SectionTitle, Switch, useToast,
} from "../components/ui";
import styles from "./SettingsMoneyServices.module.css";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Settings → Money services (/settings/money-services). Everything
// the money-transfer counter is set up with, apart from the store's
// own details on General: the company roster (on / off, sells money
// orders, what the company charges per money order) and the transfer
// form's countries. One form, one Save; it sends ONLY these two
// lists, so it can never overwrite a field on the General tab.

export default function SettingsMoneyServices() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useT();
  const identity = getCurrentIdentity();
  const { data, isLoading, isError, refetch } = useStoreInfo();
  const canEdit = hasPermission("settings", "update");

  const [companies, setCompanies] = useState<MTCompanyEntry[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const snapshot = (c: MTCompanyEntry[], k: string[]) =>
    JSON.stringify({ companies: c, countries: k });

  useEffect(() => {
    if (!data?.store) return;
    const c = (data.store.mt_companies ?? []).map((row) => ({
      ...row,
      money_orders: row.money_orders ?? true,
      money_order_charge: row.money_order_charge ?? 0,
    }));
    const k = [...(data.store.transfer_countries ?? [])];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable lists + dirty baseline from the server row
    setCompanies(c);
    setCountries(k);
    setBaseline(snapshot(c, k));
  }, [data]);

  const isDirty = baseline !== "" && snapshot(companies, countries) !== baseline;
  const guard = useUnsavedGuard(isDirty && !busy && canEdit, {
    message: t("money.unsavedMessage"),
  });

  function patch(i: number, change: Partial<MTCompanyEntry>) {
    setCompanies((list) =>
      list.map((row, j) => (j === i ? { ...row, ...change } : row)),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await updateStoreInfo({
        mt_companies: companies, transfer_countries: countries,
      });
      await queryClient.invalidateQueries({ queryKey: ["admin", "store-info"] });
      // The transfer + batch forms and the daily book pick from these.
      await queryClient.invalidateQueries({ queryKey: TRANSFER_CHOICES_KEY });
      await queryClient.invalidateQueries({ queryKey: ["dailybook"] });
      // Money order charges change the Monthly P&L.
      await queryClient.invalidateQueries({ queryKey: ["monthly"] });
      setBaseline(snapshot(companies, countries));
      toast({ message: t("money.saved"), tone: "success" });
    } catch (e) {
      setErr(apiErrorMessage(e, t("store.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  if (identity?.store_id == null) {
    return (
      <Card>
        <SectionTitle>{navWord("Money services")}</SectionTitle>
        <p className={styles.muted}>
          {t("money.signIn")}
        </p>
      </Card>
    );
  }
  if (isLoading) {
    return <Card><SectionTitle>{navWord("Money services")}</SectionTitle><Loading /></Card>;
  }
  if (isError || !data) {
    return (
      <Card>
        <SectionTitle>{navWord("Money services")}</SectionTitle>
        <ErrorState
          message={t("money.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      </Card>
    );
  }

  return (
    <form onSubmit={onSubmit} className={styles.form}>
      {/* Toggle OFF hides a company from the daily book + transfer
          form without deleting it (historical days keep its data);
          Remove drops it from the roster entirely. */}
      <Card>
        <SectionTitle>
          {t("money.companies")}
          <InfoTip text={t("money.companiesTip")} />
        </SectionTitle>
        <ul className={styles.companyList}>
          {companies.map((c, i) => {
            const sellsMo = c.enabled && c.money_orders;
            return (
              <li key={c.name} className={styles.companyRow}>
                <span className={styles.companyName}>
                  <Switch
                    checked={c.enabled}
                    disabled={!canEdit}
                    onChange={(next) => patch(i, { enabled: next })}
                  >
                    {c.name}
                  </Switch>
                  {!c.enabled && <Pill tone="neutral">{t("money.hidden")}</Pill>}
                </span>
                <Switch
                  checked={c.money_orders}
                  disabled={!canEdit || !c.enabled}
                  onChange={(next) => patch(i, { money_orders: next })}
                  aria-label={t("money.sellsMo", { name: c.name })}
                >
                  {t("money.moneyOrders")}
                </Switch>
                {/* The charge only means something for a company that
                    sells money orders, so it is not shown otherwise. */}
                {sellsMo ? (
                  <span className={styles.charge}>
                    <span className={styles.chargeInput}>
                      <MoneyInput
                        value={c.money_order_charge ?? 0}
                        onChange={(v) => patch(i, { money_order_charge: v })}
                        disabled={!canEdit}
                        placeholder="0.00"
                        fullWidth
                        aria-label={t("money.chargeAria", { name: c.name })}
                      />
                    </span>
                    <span className={styles.chargeLabel}>
                      {t("money.perMo")}
                      <InfoTip text={t("money.chargeTip")} />
                    </span>
                  </span>
                ) : <span />}
                <Button
                  type="button"
                  tone="ghost"
                  size="sm"
                  disabled={!canEdit || companies.length <= 1}
                  onClick={() =>
                    setCompanies((list) => list.filter((_, j) => j !== i))
                  }
                >
                  {t("money.remove")}
                </Button>
              </li>
            );
          })}
        </ul>
        <AddNameRow
          kind="company"
          placeholder={t("money.addCompany")}
          maxLength={30}
          existing={companies.map((c) => c.name)}
          disabled={!canEdit}
          onAdd={(name) => setCompanies((list) => [
            ...list,
            { name, enabled: true, money_orders: true, money_order_charge: 0 },
          ])}
        />
      </Card>

      {/* The transfer form's country picker. Only the picker: saved
          transfers keep their country when it leaves this list. */}
      <Card>
        <SectionTitle>
          {t("money.countries")}
          <InfoTip text={t("money.countriesTip")} />
        </SectionTitle>
        <div className={styles.countryList}>
          {countries.map((c, i) => (
            <span key={c} className={styles.countryChip}>
              {c}
              <Button
                type="button"
                tone="ghost"
                size="sm"
                aria-label={t("money.removeCountry", { name: c })}
                disabled={!canEdit || countries.length <= 1}
                onClick={() =>
                  setCountries((list) => list.filter((_, j) => j !== i))
                }
              >
                ×
              </Button>
            </span>
          ))}
        </div>
        <AddNameRow
          kind="country"
          placeholder={t("money.addCountry")}
          maxLength={60}
          existing={countries}
          disabled={!canEdit}
          onAdd={(c) => setCountries((list) => [...list, c])}
        />
      </Card>

      {err && <Alert tone="error">{err}</Alert>}

      {canEdit && (
        <FormActions guard={guard}>
          <Button type="submit" busy={busy} disabled={busy || !isDirty}>
            {busy ? t("common.saving") : t("store.save")}
          </Button>
        </FormActions>
      )}
    </form>
  );
}

/** The "type a name, press Add" row under a Settings list (money
 *  transfer companies, transfer countries). Refuses a blank name, a
 *  comma (the lists are stored comma-separated) and a name already on
 *  the list, case-insensitively, with a toast; the server re-checks. */
function AddNameRow({
  kind, placeholder, maxLength, existing, disabled, onAdd,
}: {
  kind: "company" | "country";
  placeholder: string;
  maxLength: number;
  existing: readonly string[];
  disabled: boolean;
  onAdd: (name: string) => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState("");
  const t = useT();

  function add() {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.includes(",")) {
      toast({
        message: kind === "company" ? t("money.companyComma") : t("money.countryComma"),
        tone: "info",
      });
      return;
    }
    if (existing.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      toast({ message: t("money.alreadyListed", { name: trimmed }), tone: "info" });
      return;
    }
    onAdd(trimmed);
    setValue("");
  }

  return (
    <div className={styles.addNameRow}>
      <Input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={kind === "company" ? t("money.newCompany") : t("money.newCountry")}
        maxLength={maxLength}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            // Enter adds the name instead of submitting the whole
            // settings form.
            e.preventDefault();
            add();
          }
        }}
      />
      <Button
        type="button"
        tone="secondary"
        size="sm"
        disabled={disabled || !value.trim()}
        onClick={add}
        aria-label={kind === "company" ? t("money.addCompanyAria") : t("money.addCountryAria")}
      >
        {t("money.add")}
      </Button>
    </div>
  );
}

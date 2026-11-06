import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  useTVDisplayCountryDetail,
  useUpdateTVDisplayCountry,
  type TVDisplayBankRow,
} from "../api/tvDisplay";
import {
  Button, ButtonLink, Card, Checkbox, ErrorState, Field,
  FormActions, Input, Loading, PageHeader, PageShell, Table, tdStyle,
  thStyle, useToast,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import styles from "./TVDisplayCountry.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, useT } from "../i18n";

// /app/tv-display/countries/:id — country editor for the rate
// board. Save sends the whole editor (header, company columns,
// bank renames / order / deletes, new banks, rate grid) in one
// PUT, then returns to the TV display page.
export default function TVDisplayCountry() {
  const t = useT();
  const { countryId } = useParams<{ countryId: string }>();
  const cid = Number(countryId);
  const { data, isLoading, isError, error, refetch } =
    useTVDisplayCountryDetail(cid);
  const save = useUpdateTVDisplayCountry(cid);
  const navigate = useNavigate();
  const toast = useToast();
  const toastError = useApiErrorToast();

  const [countryName, setCountryName] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [companiesText, setCompaniesText] = useState("");
  const [bankNames, setBankNames] = useState<Record<number, string>>({});
  const [bankSorts, setBankSorts] = useState<Record<number, number>>({});
  const [bankDeletes, setBankDeletes] = useState<Set<number>>(new Set());
  const [newBankNames, setNewBankNames] = useState<string[]>([""]);
  const [rateGrid, setRateGrid] = useState<Record<string, string>>({});
  // Set in the hydrate effect, so the dirty baseline is the loaded
  // country rather than the empty first render.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable country/bank/rate grid from server-fetched config; resets pending deletes/new-bank rows on each refresh
    setCountryName(data.country_name);
    setCountryCode(data.country_code);
    setCompaniesText(data.mt_companies.join(","));
    setBankNames(Object.fromEntries(data.banks.map((b) => [b.id, b.bank_name])));
    setBankSorts(Object.fromEntries(data.banks.map((b) => [b.id, b.sort_order])));
    setBankDeletes(new Set());
    setNewBankNames([""]);
    const grid: Record<string, string> = {};
    for (const b of data.banks) {
      data.mt_companies.forEach((co, idx) => {
        const v = b.rates[co];
        if (typeof v === "number") {
          grid[`rate-${b.id}-${idx}`] = String(v);
        }
      });
    }
    setRateGrid(grid);
    setHydrated(true);
  }, [data]);

  const { dirty } = useDirtyBaseline({
    countryName, countryCode, companiesText, bankNames, bankSorts,
    bankDeletes: Array.from(bankDeletes), newBankNames, rateGrid,
  }, hydrated);
  const guard = useUnsavedGuard(dirty && !save.isPending, {
    message: t("tvCountry.unsaved"),
  });

  const companies = useMemo(
    () => companiesText.split(",").map((s) => s.trim()).filter(Boolean),
    [companiesText],
  );

  if (isLoading) {
    return (
      <PageShell>
        <Loading label={t("tvCountry.loading")} />
      </PageShell>
    );
  }
  if (isError || !data) {
    return (
      <PageShell>
        <ErrorState
          message={t("tvCountry.loadFailed", { error: apiErrorMessage(error, t("tvCountry.unknownError")) })}
          onRetry={() => { void refetch(); }}
        />
      </PageShell>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    const banks = [];
    for (const b of data.banks) {
      const rates: Record<string, number | null> = {};
      for (const [idx, co] of companies.entries()) {
        const raw = (rateGrid[`rate-${b.id}-${idx}`] ?? "").trim();
        const value = raw === "" ? null : Number(raw);
        if (value !== null && (!Number.isFinite(value) || value < 0)) {
          toast({
            message: t("tvCountry.badRate", { bank: bankNames[b.id] ?? b.bank_name, raw }),
            tone: "error",
          });
          return;
        }
        rates[co] = value;
      }
      banks.push({
        id: b.id,
        bank_name: bankNames[b.id] ?? b.bank_name,
        sort_order: bankSorts[b.id] ?? b.sort_order,
        delete: bankDeletes.has(b.id),
        rates,
      });
    }
    try {
      await save.mutateAsync({
        country_name: countryName,
        country_code: countryCode,
        mt_companies: companies,
        banks,
        new_banks: newBankNames.filter((n) => n.trim().length > 0),
      });
    } catch (err) {
      toastError(err, t("tvCountry.saveFailed"));
      return;
    }
    toast({ message: t("tvCountry.saved"), tone: "success" });
    guard.proceed(() => navigate("/tv-display"));
  }

  function setRate(bankId: number, idx: number, value: string) {
    setRateGrid((g) => ({ ...g, [`rate-${bankId}-${idx}`]: value }));
  }

  function setNewBankAt(idx: number, value: string) {
    setNewBankNames((ns) => {
      const out = [...ns];
      out[idx] = value;
      // Keep one empty trailing input so adding a row is implicit.
      const trailing = out[out.length - 1];
      if (trailing.trim().length > 0) out.push("");
      return out;
    });
  }

  return (
    <PageShell>
      <div>
        <PageCrumbs current={data.country_name || t("tvCountry.country")} />

        <PageHeader
          title={data.country_name || t("tvCountry.country")}
          subtitle={[
            data.country_code,
            tn("tvCountry.banks", data.banks.length),
            tn("tvCountry.columns", data.mt_companies.length),
          ].join(" · ")}
        />
      </div>

      <form onSubmit={submit} className={styles.form}>
        <Card>
          <h2 className={styles.cardH2}>{t("tvCountry.header")}</h2>
          <Field label={t("tvCountry.name")}>
            <Input
              name="country_name"
              value={countryName}
              onChange={(e) => setCountryName(e.target.value)}
              required
              maxLength={80}
            />
          </Field>
          <Field label={t("tvCountry.iso")}>
            <Input
              name="country_code"
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              maxLength={4}
            />
          </Field>
          <Field
            label={t("tvCountry.companies")}
            hint={t("tvCountry.companiesHint")}
          >
            <Input
              name="mt_companies"
              value={companiesText}
              onChange={(e) => setCompaniesText(e.target.value)}
              maxLength={500}
            />
          </Field>
        </Card>

        <Card>
          <h2 className={styles.cardH2}>{t("tvCountry.matrix")}</h2>
          <Table>
            <thead>
              <tr>
                <th style={thStyle}>{t("tvCountry.bank")}</th>
                <th style={thStyle}>{t("tvCountry.order")}</th>
                {companies.map((co) => (
                  <th key={co} style={thStyle}>{co}</th>
                ))}
                <th style={thStyle}>{t("tvCountry.delete")}</th>
              </tr>
            </thead>
            <tbody>
              {data.banks.map((b) => (
                <BankRow
                  key={b.id}
                  bank={b}
                  companies={companies}
                  bankName={bankNames[b.id] ?? b.bank_name}
                  setBankName={(v) =>
                    setBankNames((s) => ({ ...s, [b.id]: v }))
                  }
                  bankSort={bankSorts[b.id] ?? b.sort_order}
                  setBankSort={(v) =>
                    setBankSorts((s) => ({ ...s, [b.id]: v }))
                  }
                  toDelete={bankDeletes.has(b.id)}
                  toggleDelete={() =>
                    setBankDeletes((s) => {
                      const n = new Set(s);
                      if (n.has(b.id)) n.delete(b.id);
                      else n.add(b.id);
                      return n;
                    })
                  }
                  rateGrid={rateGrid}
                  setRate={setRate}
                />
              ))}
            </tbody>
          </Table>
        </Card>

        <Card>
          <h2 className={styles.cardH2}>{t("tvCountry.addBanks")}</h2>
          {newBankNames.map((name, idx) => (
            <Input
              key={idx}
              name="new_bank_name"
              value={name}
              onChange={(e) => setNewBankAt(idx, e.target.value)}
              placeholder={t("tvCountry.newBankPlaceholder")}
              maxLength={120}
              className={styles.newBankInput}
            />
          ))}
        </Card>

        <FormActions guard={guard}>
          <ButtonLink to="/tv-display" tone="secondary">{t("common.cancel")}</ButtonLink>
          <Button
            type="submit"
            perm="settings.update"
            busy={save.isPending}
            disabled={save.isPending}
          >
            {save.isPending ? t("common.saving") : t("common.saveChanges")}
          </Button>
        </FormActions>
      </form>
    </PageShell>
  );
}

function BankRow({
  bank, companies, bankName, setBankName, bankSort, setBankSort,
  toDelete, toggleDelete, rateGrid, setRate,
}: {
  bank: TVDisplayBankRow;
  companies: string[];
  bankName: string;
  setBankName: (v: string) => void;
  bankSort: number;
  setBankSort: (v: number) => void;
  toDelete: boolean;
  toggleDelete: () => void;
  rateGrid: Record<string, string>;
  setRate: (bankId: number, idx: number, v: string) => void;
}) {
  const t = useT();
  return (
    <tr className={toDelete ? styles.rowToDelete : undefined}>
      <td style={tdStyle}>
        <Input
          name={`bank-${bank.id}-name`}
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          maxLength={120}
        />
      </td>
      <td style={tdStyle}>
        <Input
          name={`bank-${bank.id}-sort`}
          type="number"
          value={bankSort}
          onChange={(e) => setBankSort(Number(e.target.value) || 0)}
          style={{ width: "5rem" }}
        />
      </td>
      {companies.map((_, idx) => (
        <td key={idx} style={tdStyle}>
          <Input
            name={`rate-${bank.id}-${idx}`}
            value={rateGrid[`rate-${bank.id}-${idx}`] ?? ""}
            onChange={(e) => setRate(bank.id, idx, e.target.value)}
            placeholder="—"
            style={{ width: "6rem" }}
          />
        </td>
      ))}
      <td style={tdStyle}>
        <Checkbox
          name={`bank-${bank.id}-delete`}
          value="1"
          checked={toDelete}
          onChange={toggleDelete}
          style={{ alignItems: "center" }}
        >
          {t("tvCountry.deleteBox")}
        </Checkbox>
      </td>
    </tr>
  );
}

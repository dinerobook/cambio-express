import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  createCheckCompany, feeLabel, updateCheckCompany, useCheckCompany,
  type CheckCompanyDetail,
} from "../api/checkCashing";
import {
  PartyRulesFields, PartyStatusPill, type PartyRules,
} from "../components/CheckCashingFields";
import { CheckActivity } from "../components/CheckActivity";
import { DeskColumns, DeskForm, DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Alert, Button, Card, ErrorState, Field, FormActions, Input, Loading,
  PageHeader, SectionTitle, Textarea, useToast,
} from "../components/ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { hasPermission } from "../lib/permissions";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./CheckCashing.module.css";

// Check cashing app → Companies → New company / a company's profile
// (/app/check-cashing/companies/new, /:id). The routing and account
// numbers (from the bottom line of the check) identify the company:
// the server checks the routing number's check digit and refuses a
// pair another company already holds.

interface Form {
  name: string;
  routing_number: string;
  account_number: string;
  address: string;
  phone: string;
  notes: string;
}

const EMPTY_FORM: Form = {
  name: "", routing_number: "", account_number: "", address: "", phone: "", notes: "",
};
const EMPTY_RULES: PartyRules = {
  status: "normal", status_reason: "", fee_kind: null, fee_value: null,
};

function fromDetail(c: CheckCompanyDetail): { form: Form; rules: PartyRules } {
  return {
    form: {
      name: c.name, routing_number: c.routing_number, account_number: c.account_number,
      address: c.address, phone: c.phone, notes: c.notes,
    },
    rules: {
      status: c.status as PartyRules["status"], status_reason: c.status_reason,
      fee_kind: (c.fee_kind as PartyRules["fee_kind"]) ?? null,
      fee_value: c.fee_value ?? null,
    },
  };
}

const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

export default function CheckCompanyForm() {
  const t = useT();
  const { id } = useParams<{ id?: string }>();
  const isEdit = id !== undefined;
  const companyId = isEdit ? Number(id) : NaN;
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const canManage = hasPermission("check_cashing_manage", "update");
  const canEdit = hasPermission("check_cashing", isEdit ? "update" : "create");

  const detail = useCheckCompany(isEdit ? companyId : undefined);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [rules, setRules] = useState<PartyRules>(EMPTY_RULES);
  const [baseline, setBaseline] = useState(JSON.stringify({ form: EMPTY_FORM, rules: EMPTY_RULES }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const next = fromDetail(detail.data.company);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable form + dirty baseline from the fetched company
    setForm(next.form);
    setRules(next.rules);
    setBaseline(JSON.stringify(next));
  }, [isEdit, detail.data]);

  const guard = useUnsavedGuard(JSON.stringify({ form, rules }) !== baseline && !busy, {
    message: t("checkCashing.unsavedCompany"),
  });

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = { ...form, name: form.name.trim(), ...rules };
    try {
      if (isEdit) {
        const res = await updateCheckCompany(companyId, body);
        setBaseline(JSON.stringify(fromDetail(res.company)));
        toast({ message: t("checkCashing.companySaved"), tone: "success" });
      } else {
        const res = await createCheckCompany(body);
        toast({ message: t("checkCashing.companyAdded"), tone: "success" });
        guard.proceed(() => navigate(
          `/check-cashing/companies/${res.company.id}`, { replace: true },
        ));
      }
      void queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  const title = isEdit
    ? detail.data?.company.name || t("checkCashing.companyTitle")
    : t("checkCashing.newCompany");

  if (identity?.store_id == null) {
    return (
      <DeskPage>
        <PageHeader title={title} />
        <p>{t("checkCashing.signIn")}</p>
      </DeskPage>
    );
  }
  if (isEdit && detail.isError && !detail.data) {
    return (
      <DeskPage>
        <PageCrumbs current={t("checkCashing.companyTitle")} />
        <PageHeader title={t("checkCashing.companyTitle")} />
        <ErrorState
          message={apiErrorMessage(detail.error, t("checkCashing.loadFailed"))}
          onRetry={() => void detail.refetch()}
          busy={detail.isFetching}
        />
      </DeskPage>
    );
  }
  if (isEdit && !detail.data) {
    return <DeskPage><Loading /></DeskPage>;
  }

  const company = detail.data?.company;
  // Both numbers, or neither (the server says the same).
  const numbersHalf = Boolean(form.routing_number) !== Boolean(form.account_number);
  const routingShort = form.routing_number !== "" && form.routing_number.length !== 9;

  return (
    <DeskPage>
      <PageCrumbs current={isEdit ? title : t("checkCashing.newCompany")} />
      <PageHeader
        title={title}
        subtitle={company ? (
          <span className={styles.statusCell}>
            <PartyStatusPill status={company.status} />
            {company.home_store_name && (
              <span className={styles.muted}>
                {t("checkCashing.addedAt", { store: company.home_store_name })}
              </span>
            )}
          </span>
        ) : t("checkCashing.newCompanySubtitle")}
      />

      <DeskColumns>
      <DeskForm onSubmit={onSubmit}>
        <DeskPane>
        <fieldset disabled={!canEdit} className={`${styles.fieldset} ds-form`}>
          <Card>
            <SectionTitle>{t("checkCashing.companyDetails")}</SectionTitle>
            <div className={styles.fieldGrid}>
              <Field label={t("checkCashing.companyName")} style={{ gridColumn: "1 / -1" }}>
                <Input
                  type="text" required maxLength={160}
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field
                label={t("checkCashing.routing")}
                hint={t("checkCashing.routingHint")}
                error={routingShort ? t("checkCashing.routingNine") : undefined}
              >
                <Input
                  type="text" inputMode="numeric" autoComplete="off"
                  value={form.routing_number}
                  onChange={(e) => set("routing_number", digits(e.target.value, 9))}
                />
              </Field>
              <Field
                label={t("checkCashing.account")}
                error={numbersHalf ? t("checkCashing.numbersTogether") : undefined}
              >
                <Input
                  type="text" inputMode="numeric" autoComplete="off"
                  value={form.account_number}
                  onChange={(e) => set("account_number", digits(e.target.value, 20))}
                />
              </Field>
              <Field label={t("checkCashing.phone")}>
                <Input
                  type="tel" maxLength={40}
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.address")}>
                <Input
                  type="text" maxLength={255}
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                />
              </Field>
            </div>
            <Field label={t("checkCashing.notes")}>
              <Textarea
                rows={3} maxLength={4000}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </Field>
          </Card>

          <Card>
            <SectionTitle>{t("checkCashing.statusAndFee")}</SectionTitle>
            {canManage ? (
              <PartyRulesFields
                rules={rules}
                onChange={setRules}
                feeHint={t("checkCashing.companyFeeHint")}
              />
            ) : (
              <div className={styles.statusCell}>
                <PartyStatusPill status={rules.status} />
                <span className={styles.muted}>
                  {t("checkCashing.ownFeeIs", { fee: feeLabel(rules.fee_kind, rules.fee_value) })}
                </span>
              </div>
            )}
          </Card>
        </fieldset>
        </DeskPane>

        {error && <Alert tone="error">{error}</Alert>}

        {canEdit && (
          <FormActions guard={guard}>
            <Button
              type="button" tone="secondary"
              onClick={() => guard.confirmLeave(() => navigate("/check-cashing/companies", { replace: true }))}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="submit" busy={busy}
              disabled={busy || !form.name.trim() || numbersHalf || routingShort}
            >
              {isEdit ? t("checkCashing.saveChanges") : t("checkCashing.addCompany")}
            </Button>
          </FormActions>
        )}
      </DeskForm>
      {company && (
        <Card>
          <SectionTitle>{t("checkCashing.checksTitle")}</SectionTitle>
          <CheckActivity kind="companies" id={company.id} other="customer" />
        </Card>
      )}
      </DeskColumns>
    </DeskPage>
  );
}

import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate, useParams } from "react-router-dom";

import DebitCardCheckbox from "../components/DebitCardCheckbox";
import FederalTaxPreview from "../components/FederalTaxPreview";
import SenderAutocomplete from "../components/SenderAutocomplete";
import StoreListField from "../components/StoreListField";
import RecipientSuggestions from "../components/RecipientSuggestions";
import {
  Alert, Button, Card, DateInput, ErrorState, Field,
  FormActions, InfoTip, Input, Loading, MoneyInput, PageHeader, PageShell,
  Pill, Section, Select, useToast,
} from "../components/ui";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  updateTransfer,
  useEmployees,
  useTransfer,
  useTransferChoices,
} from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  DEFAULT_SERVICE, DEFAULT_STATUS, SERVICES, STATUSES, isPayout,
  serviceLabel, statusLabel, transferWording,
} from "../lib/transferKinds";
import styles from "./EditTransfer.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tIfKey, useT } from "../i18n";


// ── Validation schema ──────────────────────────────────────────
//
// Mirrors NewTransfer's schema + batch_id for edit. Server-side
// is still the source of truth — Zod here is for instant client
// feedback + type narrowing.

// Messages are translator keys, shown with tIfKey() (see NewTransfer).
const editSchema = z.object({
  send_date: z.string().min(1, "transfer.dateRequired"),
  company: z.string().min(1, "transfer.pickCompany"),
  service_type: z.enum(SERVICES),
  payment_method: z.enum(["cash", "debit_card"]),
  status: z.enum(STATUSES),

  sender_name: z.string().min(1, "transfer.nameRequired"),
  sender_phone_country: z.string(),
  sender_phone: z.string(),
  sender_address: z.string(),
  sender_dob: z.string(),
  customer_id: z.number().int().positive().nullable(),

  country: z.string(),
  recipient_name: z.string(),
  recipient_phone: z.string(),

  send_amount: z.number().positive("transfer.amountPositive"),
  fee: z.number().min(0, "transfer.feeNotNegative"),
  confirm_number: z.string(),

  employee_id: z
    .number({ message: "transfer.pickEmployee" })
    .int()
    .positive(),

  batch_id: z.string(),
});

type EditFormValues = z.infer<typeof editSchema>;

const defaultValues: EditFormValues = {
  send_date: "",
  company: "",
  service_type: DEFAULT_SERVICE,
  payment_method: "cash",
  status: DEFAULT_STATUS,
  sender_name: "",
  sender_phone_country: "+1",
  sender_phone: "",
  sender_address: "",
  sender_dob: "",
  customer_id: null,
  country: "",
  recipient_name: "",
  recipient_phone: "",
  send_amount: 0,
  fee: 0,
  confirm_number: "",
  employee_id: undefined as unknown as number,
  batch_id: "",
};


export default function EditTransfer() {
  const t = useT();
  const { id } = useParams<{ id: string }>();
  const transferId = id ? Number(id) : NaN;
  const navigate = useNavigate();
  const toast = useToast();
  const identity = getCurrentIdentity();
  const detail = useTransfer(Number.isFinite(transferId) ? transferId : undefined);
  const roster = useEmployees();
  const choices = useTransferChoices();
  const companies = choices.data?.companies;
  const countries = choices.data?.countries;

  const {
    register, handleSubmit, control, setValue, getValues, setError,
    clearErrors, reset, formState: { errors, isSubmitting, isDirty },
  } = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues,
    mode: "onSubmit",
  });

  // Hydrate form from the server-fetched transfer. `reset()`
  // replaces every field at once so the form doesn't flicker
  // through intermediate states.
  useEffect(() => {
    if (!detail.data) return;
    const row = detail.data.transfer;
    reset({
      send_date: row.send_date,
      // Company + country stay exactly as saved, even when Settings
      // has since dropped them (StoreListField still offers them).
      company: row.company,
      service_type: (SERVICES as readonly string[]).includes(row.service_type)
        ? (row.service_type as (typeof SERVICES)[number])
        : DEFAULT_SERVICE,
      payment_method: row.payment_method === "debit_card" ? "debit_card" : "cash",
      status: (STATUSES as readonly string[]).includes(row.status)
        ? (row.status as (typeof STATUSES)[number])
        : DEFAULT_STATUS,
      // Every field the PUT replaces is hydrated from the detail, so
      // saving an edit never blanks what the operator did not touch.
      sender_name: row.sender_name || "",
      sender_phone_country: row.sender_phone_country || "+1",
      sender_phone: row.sender_phone || "",
      sender_address: row.sender_address || "",
      sender_dob: row.sender_dob || "",
      customer_id: row.customer_id ?? null,
      country: row.country || "",
      recipient_name: row.recipient_name || "",
      recipient_phone: row.recipient_phone || "",
      send_amount: row.send_amount,
      fee: row.fee,
      confirm_number: row.confirm_number || "",
      employee_id: (row.employee_id ?? undefined) as unknown as number,
      batch_id: row.batch_id || "",
    });
  }, [detail.data, reset]);

  const stored = detail.data?.transfer;
  const formerEmployee =
    stored?.employee_id != null
    && roster.data
    && !roster.data.employees.some((e) => e.id === stored.employee_id)
      ? { id: stored.employee_id, name: stored.employee_name || t("transfer.formerEmployee") }
      : null;

  const sendAmount = useWatch({ control, name: "send_amount" });
  const serviceType = useWatch({ control, name: "service_type" });
  const country = useWatch({ control, name: "country" });
  const paymentMethod = useWatch({ control, name: "payment_method" });
  const customerId = useWatch({ control, name: "customer_id" });
  const payout = isPayout(serviceType);
  const words = transferWording(serviceType);

  // A payout is cash handed to the recipient: never by card, never a
  // fee (the server refuses both). Clear them when Payout is picked —
  // only on a change, so hydrating a saved payout doesn't dirty the form.
  useEffect(() => {
    if (!payout) return;
    if (getValues("payment_method") !== "cash") {
      setValue("payment_method", "cash", { shouldDirty: true });
    }
    if (getValues("fee") !== 0) setValue("fee", 0, { shouldDirty: true });
  }, [payout, getValues, setValue]);

  // Warn before losing unsaved edits: browser prompt on close/refresh +
  // an in-app discard confirm on Cancel, via the shared guard.
  const guard = useUnsavedGuard(isDirty && !isSubmitting, {
    message: t("transfer.unsavedMessage"),
  });
  function onCancel() {
    guard.confirmLeave(() => navigate(`/transfers/${transferId}`));
  }

  async function onSubmit(values: EditFormValues) {
    clearErrors("root");
    try {
      // Commission and notes have no field on this form; send back
      // what the transfer holds so the full-row PUT keeps them.
      const result = await updateTransfer(transferId, {
        ...values,
        commission: stored?.commission ?? 0,
        status_notes: stored?.status_notes ?? "",
        internal_notes: stored?.internal_notes ?? "",
      });
      toast({ message: t("transfer.updated"), tone: "success" });
      guard.proceed(() => navigate(`/transfers/${result.transfer.id}`, { replace: true }));
    } catch (err) {
      setError("root", {
        message: apiErrorMessage(err, t("transfer.updateFailed")),
      });
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title={t("transfer.editTitle")} />
        <p>{t("transfer.editSignIn")}</p>
      </PageShell>
    );
  }

  if (!Number.isFinite(transferId)) {
    return (
      <PageShell maxWidth="62rem">
        <p>{t("transfer.invalidId")}</p>
      </PageShell>
    );
  }

  if (detail.isLoading) {
    return (
      <PageShell maxWidth="62rem">
        <Loading />
      </PageShell>
    );
  }

  if (detail.isError) {
    return (
      <PageShell maxWidth="62rem">
        <ErrorState
          message={
            apiErrorMessage(detail.error, t("transfer.loadFailed"))
          }
          onRetry={() => { void detail.refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="62rem">
      <PageCrumbs
        via={[{ label: t("transfer.number", { id: transferId }), to: `/transfers/${transferId}` }]}
        current={t("transfer.edit")}
      />
      <PageHeader
        title={t("transfer.editNumber", { id: transferId })}
        subtitle={t("transfer.editSubtitle")}
      />

      {choices.isError && (
        <ErrorState
          message={t("transfer.choicesFailed")}
          onRetry={() => { void choices.refetch(); }}
        />
      )}

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="ds-form"
      >
        <Card>
          <Section title={t("transfer.whenHow")}>
            <div className={styles.grid}>
              <Field label={t("transfer.date")} highlight={!!errors.send_date}>
                <Controller
                  name="send_date"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <DateInput
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value)}
                      required
                    />
                  )}
                />
              </Field>
              <Controller
                control={control}
                name="company"
                render={({ field }) => (
                  <StoreListField
                    label={t("transfer.company")}
                    options={companies}
                    value={field.value}
                    onChange={field.onChange}
                    loading={choices.isLoading || choices.isError}
                    error={tIfKey(errors.company?.message)}
                    emptyText={t("transfer.noCompanies")}
                  />
                )}
              />
              <Field label={t("transfer.service")}>
                <Select {...register("service_type")}>
                  {SERVICES.map((c) => <option key={c} value={c}>{serviceLabel(c)}</option>)}
                </Select>
              </Field>
              <Field label={t("transfer.status")}>
                <Select {...register("status")}>
                  {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
                </Select>
              </Field>
            </div>
            {!payout && (
              <Controller
                control={control}
                name="payment_method"
                render={({ field }) => (
                  <DebitCardCheckbox
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            )}
          </Section>
        </Card>

        <Card>
          <Section title={words.customer}>
            <div className={styles.grid}>
              <Field label={t("transfer.fullName")} highlight={!!errors.sender_name}>
                <Controller
                  control={control}
                  name="sender_name"
                  render={({ field }) => (
                    <SenderAutocomplete
                      value={field.value}
                      onChange={field.onChange}
                      onPick={(row) => {
                        setValue("sender_name", row.full_name);
                        setValue("sender_phone_country",
                          row.phone_country || "+1");
                        setValue("sender_phone", row.phone_number);
                        setValue("sender_address", row.address);
                        setValue("sender_dob", row.dob || "");
                        setValue("customer_id", row.id);
                      }}
                      onClearPickedId={() =>
                        setValue("customer_id", null)
                      }
                      required
                    />
                  )}
                />
              </Field>
              <Field label={t("transfer.phoneCountry")}>
                <Input
                  type="text"
                  placeholder="+1"
                  {...register("sender_phone_country")}
                />
              </Field>
              <Field label={t("transfer.phone")}>
                <Input type="tel" {...register("sender_phone")} />
              </Field>
              <Field label={t("transfer.address")}>
                <Input type="text" {...register("sender_address")} />
              </Field>
            </div>
            {customerId != null && (
              <p className={styles.note}>
                <Pill tone="info">{t("transfer.linkedCustomer", { id: customerId })}</Pill>
                <InfoTip text={t("transfer.linkedCustomerTip")} />
              </p>
            )}
          </Section>
        </Card>

        <Card>
          <Section title={words.other}>
            <RecipientSuggestions
              customerId={customerId ?? null}
              storeId={identity.store_id}
              onPick={(row) => {
                setValue("recipient_name", row.name);
                if (row.country && countries?.includes(row.country)) {
                  setValue("country", row.country);
                }
                setValue("recipient_phone", row.phone);
              }}
            />
            <div className={styles.grid}>
              <Controller
                control={control}
                name="country"
                render={({ field }) => (
                  <StoreListField
                    label={words.country}
                    options={countries}
                    value={field.value}
                    onChange={field.onChange}
                    loading={choices.isLoading || choices.isError}
                    emptyText={t("transfer.noCountries")}
                  />
                )}
              />
              <Field label={words.otherName}>
                <Input type="text" {...register("recipient_name")} />
              </Field>
              <Field label={words.otherPhone}>
                <Input type="tel" {...register("recipient_phone")} />
              </Field>
            </div>
          </Section>
        </Card>

        <Card>
          <Section title={t("transfer.amounts")}>
            <div className={styles.grid}>
              <Controller
                control={control}
                name="send_amount"
                render={({ field }) => (
                  <MoneyInput
                    label={words.amount}
                    value={field.value ?? 0}
                    onChange={field.onChange}
                    error={tIfKey(errors.send_amount?.message)}
                  />
                )}
              />
              {!payout && (
                <Controller
                  control={control}
                  name="fee"
                  render={({ field }) => (
                    <MoneyInput
                      label={t("transfer.fee")}
                      value={field.value ?? 0}
                      onChange={field.onChange}
                      error={tIfKey(errors.fee?.message)}
                    />
                  )}
                />
              )}
              <FederalTaxPreview
                sendAmount={sendAmount}
                serviceType={serviceType}
                country={country ?? ""}
                paymentMethod={paymentMethod}
                rate={choices.data?.federal_tax_rate ?? 0}
              />
              <Field label={t("transfer.confirmNumber")}>
                <Input type="text" {...register("confirm_number")} />
              </Field>
            </div>
          </Section>
        </Card>

        <Card>
          <Section title={t("transfer.processedBy")}>
            <div className={styles.grid}>
              <Field label={t("transfer.employee")} highlight={!!errors.employee_id}>
                <Select
                  {...register("employee_id", {
                    setValueAs: (v) => v === "" ? null : Number(v),
                  })}
                  required
                  disabled={roster.isLoading}
                >
                  <option value="">{t("transfer.selectPlaceholder")}</option>
                  {roster.data?.employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                  {/* The roster lists active staff only. A transfer taken
                      by someone who has since left keeps them selectable,
                      so saving an edit does not move the attribution. */}
                  {formerEmployee && (
                    <option value={formerEmployee.id}>
                      {t("transfer.formerSuffix", { name: formerEmployee.name })}
                    </option>
                  )}
                </Select>
                {errors.employee_id && (
                  <span className={styles.fieldError}>
                    {tIfKey(errors.employee_id.message)}
                  </span>
                )}
              </Field>
            </div>
            <p className={styles.note}>
              {t("transfer.employeeRequiredNote")}
            </p>
          </Section>
        </Card>

        {errors.root && <Alert tone="error">{errors.root.message}</Alert>}

        <FormActions guard={guard}>
          <Button
            type="button"
            tone="secondary"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {isSubmitting ? t("transfer.saving") : t("transfer.saveChanges")}
          </Button>
        </FormActions>
      </form>
    </PageShell>
  );
}

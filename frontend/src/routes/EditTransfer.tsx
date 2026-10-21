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
  Alert, Button, Card, ConfirmDialog, DateInput, ErrorState,
  Field, FormActions, InfoTip, Input, Loading, MoneyInput, PageHeader,
  PageShell, Pill, Section, Select,
  useToast,
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
  SERVICES, STATUSES, isPayout, transferWording,
} from "../lib/transferKinds";
import styles from "./EditTransfer.module.css";
import { PageCrumbs } from "../components/PageCrumbs";


// ── Validation schema ──────────────────────────────────────────
//
// Mirrors NewTransfer's schema + batch_id for edit. Server-side
// is still the source of truth — Zod here is for instant client
// feedback + type narrowing.

const editSchema = z.object({
  send_date: z.string().min(1, "Date is required"),
  company: z.string().min(1, "Pick a company"),
  service_type: z.enum(SERVICES),
  payment_method: z.enum(["cash", "debit_card"]),
  status: z.enum(STATUSES),

  sender_name: z.string().min(1, "Name is required"),
  sender_phone_country: z.string(),
  sender_phone: z.string(),
  sender_address: z.string(),
  sender_dob: z.string(),
  customer_id: z.number().int().positive().nullable(),

  country: z.string(),
  recipient_name: z.string(),
  recipient_phone: z.string(),

  send_amount: z.number().positive("Amount must be > 0"),
  fee: z.number().min(0, "Fee must be ≥ 0"),
  confirm_number: z.string(),

  employee_id: z
    .number({ message: "Pick an employee" })
    .int()
    .positive(),

  batch_id: z.string(),
});

type EditFormValues = z.infer<typeof editSchema>;

const defaultValues: EditFormValues = {
  send_date: "",
  company: "",
  service_type: "Money Transfer",
  payment_method: "cash",
  status: "Sent",
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
    const t = detail.data.transfer;
    reset({
      send_date: t.send_date,
      // Company + country stay exactly as saved, even when Settings
      // has since dropped them (StoreListField still offers them).
      company: t.company,
      service_type: (SERVICES as readonly string[]).includes(t.service_type)
        ? (t.service_type as (typeof SERVICES)[number])
        : "Money Transfer",
      payment_method: t.payment_method === "debit_card" ? "debit_card" : "cash",
      status: (STATUSES as readonly string[]).includes(t.status)
        ? (t.status as (typeof STATUSES)[number])
        : "Sent",
      // Every field the PUT replaces is hydrated from the detail, so
      // saving an edit never blanks what the operator did not touch.
      sender_name: t.sender_name || "",
      sender_phone_country: t.sender_phone_country || "+1",
      sender_phone: t.sender_phone || "",
      sender_address: t.sender_address || "",
      sender_dob: t.sender_dob || "",
      customer_id: t.customer_id ?? null,
      country: t.country || "",
      recipient_name: t.recipient_name || "",
      recipient_phone: t.recipient_phone || "",
      send_amount: t.send_amount,
      fee: t.fee,
      confirm_number: t.confirm_number || "",
      employee_id: (t.employee_id ?? undefined) as unknown as number,
      batch_id: t.batch_id || "",
    });
  }, [detail.data, reset]);

  const stored = detail.data?.transfer;
  const formerEmployee =
    stored?.employee_id != null
    && roster.data
    && !roster.data.employees.some((e) => e.id === stored.employee_id)
      ? { id: stored.employee_id, name: stored.employee_name || "Former employee" }
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
    message: "You have unsaved edits on this transfer. Leave without saving?",
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
      toast({ message: "Transfer updated.", tone: "success" });
      navigate(`/transfers/${result.transfer.id}`, { replace: true });
    } catch (err) {
      setError("root", {
        message: apiErrorMessage(err, "Could not save the changes. Please try again."),
      });
    }
  }

  if (identity?.store_id == null) {
    return (
      <PageShell maxWidth="62rem">
        <PageHeader title="Edit transfer" />
        <p>Sign in as a store admin to edit transfers.</p>
      </PageShell>
    );
  }

  if (!Number.isFinite(transferId)) {
    return (
      <PageShell maxWidth="62rem">
        <p>Invalid transfer ID.</p>
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
            apiErrorMessage(detail.error, "Could not load this transfer.")
          }
          onRetry={() => { void detail.refetch(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="62rem">
      <PageCrumbs via={[{ label: `Transfer #${transferId}`, to: `/transfers/${transferId}` }]} current="Edit" />
      <PageHeader
        title={`Edit transfer #${transferId}`}
        subtitle="Federal tax is recomputed server-side on save."
      />

      {choices.isError && (
        <ErrorState
          message="Could not load the store's companies and countries."
          onRetry={() => { void choices.refetch(); }}
        />
      )}

      <form
        onSubmit={handleSubmit(onSubmit)}
        className="ds-form"
      >
        <Card>
          <Section title="When + how">
            <div className={styles.grid}>
              <Field label="Date" highlight={!!errors.send_date}>
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
                    label="Company"
                    options={companies}
                    value={field.value}
                    onChange={field.onChange}
                    loading={choices.isLoading || choices.isError}
                    error={errors.company?.message}
                    emptyText="No money transfer companies are switched on. Add or turn one on in"
                  />
                )}
              />
              <Field label="Service">
                <Select {...register("service_type")}>
                  {SERVICES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Status">
                <Select {...register("status")}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
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
              <Field label="Full name" highlight={!!errors.sender_name}>
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
              <Field label="Phone country">
                <Input
                  type="text"
                  placeholder="+1"
                  {...register("sender_phone_country")}
                />
              </Field>
              <Field label="Phone">
                <Input type="tel" {...register("sender_phone")} />
              </Field>
              <Field label="Address">
                <Input type="text" {...register("sender_address")} />
              </Field>
            </div>
            {customerId != null && (
              <p className={styles.note}>
                <Pill tone="info">Linked to customer #{customerId}</Pill>
                <InfoTip text="This sender is linked to the customer directory — edits to their details here sync back to their customer record." />
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
                    emptyText="No countries on the store's list. Add them in"
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
          <Section title="Amounts">
            <div className={styles.grid}>
              <Controller
                control={control}
                name="send_amount"
                render={({ field }) => (
                  <MoneyInput
                    label={words.amount}
                    value={field.value ?? 0}
                    onChange={field.onChange}
                    error={errors.send_amount?.message}
                  />
                )}
              />
              {!payout && (
                <Controller
                  control={control}
                  name="fee"
                  render={({ field }) => (
                    <MoneyInput
                      label="Fee"
                      value={field.value ?? 0}
                      onChange={field.onChange}
                      error={errors.fee?.message}
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
              <Field label="Confirmation #">
                <Input type="text" {...register("confirm_number")} />
              </Field>
            </div>
          </Section>
        </Card>

        <Card>
          <Section title="Processed by">
            <div className={styles.grid}>
              <Field label="Employee" highlight={!!errors.employee_id}>
                <Select
                  {...register("employee_id", {
                    setValueAs: (v) => v === "" ? null : Number(v),
                  })}
                  required
                  disabled={roster.isLoading}
                >
                  <option value="">— Select —</option>
                  {roster.data?.employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                  {/* The roster lists active staff only. A transfer taken
                      by someone who has since left keeps them selectable,
                      so saving an edit does not move the attribution. */}
                  {formerEmployee && (
                    <option value={formerEmployee.id}>
                      {formerEmployee.name} (former)
                    </option>
                  )}
                </Select>
                {errors.employee_id && (
                  <span className={styles.fieldError}>
                    {errors.employee_id.message}
                  </span>
                )}
              </Field>
            </div>
            <p className={styles.note}>
              Required: the cashier who took the cash for this transfer.
            </p>
          </Section>
        </Card>

        {errors.root && <Alert tone="error">{errors.root.message}</Alert>}

        <FormActions>
          {isDirty && (
            <span className={styles.unsavedNote}>
              <Pill tone="warning" dot>Unsaved changes</Pill>
            </span>
          )}
          <Button
            type="button"
            tone="secondary"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        </FormActions>
      </form>

      <ConfirmDialog {...guard.dialogProps} />
    </PageShell>
  );
}

import { useEffect, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";

import DebitCardCheckbox from "./DebitCardCheckbox";
import FederalTaxPreview from "./FederalTaxPreview";
import SenderAutocomplete from "./SenderAutocomplete";
import StoreListField from "./StoreListField";
import RecipientSuggestions from "./RecipientSuggestions";
import {
  Alert, Button, Card, DateInput, Empty, ErrorState, Field,
  FormActions, InfoTip, Input, MoneyInput, Pill, Section, Select, useToast,
} from "./ui";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  useEmployees, useTransferChoices, type TransferResponse,
} from "../api/transfers";
import { apiErrorMessage } from "../lib/api";
import {
  SERVICES, STATUSES, defaultCountry, isPayout, serviceLabel, statusLabel,
  transferWording,
} from "../lib/transferKinds";
import { transferSchema, type TransferFormValues } from "../lib/transferForm";
import { tIfKey, useT } from "../i18n";
import styles from "./TransferForm.module.css";

// The money transfer form: ONE form for New transfer and Edit
// transfer (they were two hand-kept copies until the shared form).
// The page owns the title, the trail and where the values come from;
// this owns every field, the store's lists, the employee roster, the
// payout / debit card rules, the unsaved-changes guard and the save.
//
// Form stack (the SPA's canonical example, frontend/CLAUDE.md
// "Forms"): kit primitives for layout; react-hook-form + zod for state
// and validation (schema in lib/transferForm.ts); plain inputs use
// register(), custom inputs sit in <Controller>; useWatch() for the
// few fields the rest of the form reacts to.

export interface TransferFormProps {
  /** What the form starts on. A new value (the server sent a newer
   *  copy of the transfer) starts the form over from it. */
  initialValues: TransferFormValues;
  /** New transfer: move company and country onto the store's first
   *  company and default country once the lists load. */
  startOnStoreLists?: boolean;
  /** Edit: the employee saved on the transfer. When they are no longer
   *  on the active roster they stay selectable as "(former)", so an
   *  edit never moves the attribution. */
  keepEmployee?: { id: number; name: string } | null;
  /** The signed-in store, for the recent recipients chips. */
  storeId: number;
  submitLabel: string;
  /** Where Cancel goes (after the leave prompt when there are edits). */
  cancelTo: string;
  savedMessage: string;
  failedMessage: string;
  /** Sends the values; the form then opens the saved transfer. */
  save: (values: TransferFormValues) => Promise<TransferResponse>;
}

export default function TransferForm({
  initialValues, startOnStoreLists = false, keepEmployee = null, storeId,
  submitLabel, cancelTo, savedMessage, failedMessage, save,
}: TransferFormProps) {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const roster = useEmployees();
  const choices = useTransferChoices();
  const companies = choices.data?.companies;
  const countries = choices.data?.countries;

  const {
    register, handleSubmit, control, setValue, getValues, setError,
    clearErrors, reset, formState: { errors, isSubmitting, isDirty },
  } = useForm<TransferFormValues>({
    resolver: zodResolver(transferSchema),
    defaultValues: initialValues,
    mode: "onSubmit",  // field errors on submit, not as the user types
  });

  // A newer copy of the stored transfer replaces every field at once,
  // so the form never flickers through half-hydrated states.
  const shownValues = useRef(initialValues);
  useEffect(() => {
    if (shownValues.current === initialValues) return;
    shownValues.current = initialValues;
    reset(initialValues);
  }, [initialValues, reset]);

  // New transfer: start on the store's first company and its default
  // country once the lists arrive. They become the form's defaults (so
  // loading them is not an unsaved edit), and anything typed is kept.
  const [listsApplied, setListsApplied] = useState(!startOnStoreLists);
  useEffect(() => {
    if (listsApplied || !companies || !countries) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: adopt the server-fetched store lists as form defaults
    setListsApplied(true);
    reset(
      {
        ...initialValues,
        company: companies[0] ?? "",
        country: defaultCountry(countries),
      },
      { keepDirtyValues: true },
    );
  }, [listsApplied, companies, countries, initialValues, reset]);

  const sendAmount = useWatch({ control, name: "send_amount" });
  const serviceType = useWatch({ control, name: "service_type" });
  const country = useWatch({ control, name: "country" });
  const paymentMethod = useWatch({ control, name: "payment_method" });
  const customerId = useWatch({ control, name: "customer_id" });
  const payout = isPayout(serviceType);
  const words = transferWording(serviceType);

  // A payout is cash handed to the recipient: never by card, never a
  // fee (the server refuses both). Clear them when Payout is picked,
  // only on a change, so opening a saved payout leaves no edit behind.
  useEffect(() => {
    if (!payout) return;
    if (getValues("payment_method") !== "cash") {
      setValue("payment_method", "cash", { shouldDirty: true });
    }
    if (getValues("fee") !== 0) setValue("fee", 0, { shouldDirty: true });
  }, [payout, getValues, setValue]);

  // Losing a half-entered transfer: browser prompt on refresh / close,
  // the leave prompt on in-app navigation and on Cancel.
  const guard = useUnsavedGuard(isDirty && !isSubmitting, {
    message: t("transfer.unsavedMessage"),
  });

  // The roster lists active staff only.
  const formerEmployee =
    keepEmployee
    && roster.data
    && !roster.data.employees.some((e) => e.id === keepEmployee.id)
      ? keepEmployee
      : null;

  async function onSubmit(values: TransferFormValues) {
    clearErrors("root");
    try {
      const result = await save(values);
      toast({ message: savedMessage, tone: "success" });
      guard.proceed(() => navigate(`/transfers/${result.transfer.id}`, { replace: true }));
    } catch (err) {
      setError("root", { message: apiErrorMessage(err, failedMessage) });
    }
  }

  return (
    <>
      {choices.isError && (
        <ErrorState
          message={t("transfer.choicesFailed")}
          onRetry={() => { void choices.refetch(); }}
        />
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="ds-form">
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
                  {SERVICES.map((c) => (
                    <option key={c} value={c}>{serviceLabel(c)}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("transfer.status")}>
                <Select {...register("status")}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </Select>
              </Field>
            </div>
            {!payout && (
              <Controller
                control={control}
                name="payment_method"
                render={({ field }) => (
                  <DebitCardCheckbox value={field.value} onChange={field.onChange} />
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
                        // Autofill the rest of the sender block and pin
                        // customer_id so the upsert reuses the row.
                        setValue("sender_name", row.full_name);
                        setValue("sender_phone_country", row.phone_country || "+1");
                        setValue("sender_phone", row.phone_number);
                        setValue("sender_address", row.address);
                        setValue("sender_dob", row.dob || "");
                        setValue("customer_id", row.id);
                      }}
                      onClearPickedId={() => setValue("customer_id", null)}
                      required
                    />
                  )}
                />
              </Field>
              <Field label={t("transfer.phoneCountry")}>
                <Input type="text" placeholder="+1" {...register("sender_phone_country")} />
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
            {/* Recent recipients of the picked sender: one tap fills
                name, country and phone. Hidden with no sender picked
                or no history. */}
            <RecipientSuggestions
              customerId={customerId}
              storeId={storeId}
              onPick={(row) => {
                setValue("recipient_name", row.name);
                // Only a country on the store's list: past transfers
                // may hold one Settings has since dropped.
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
                    label={t("transfer.inUsd", { label: words.amount })}
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
                      label={t("transfer.inUsd", { label: t("transfer.fee") })}
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
              <Field
                label={t("transfer.employee")}
                highlight={!!errors.employee_id}
                error={tIfKey(errors.employee_id?.message)}
              >
                {/* Controlled, not register(): the roster can arrive
                    after the form opens, and an uncontrolled select
                    whose option was missing at mount shows "— Select —"
                    over a saved employee. */}
                <Controller
                  control={control}
                  name="employee_id"
                  render={({ field }) => (
                    <Select
                      name={field.name}
                      ref={field.ref}
                      value={field.value == null ? "" : String(field.value)}
                      onChange={(e) => field.onChange(
                        e.target.value === "" ? null : Number(e.target.value),
                      )}
                      onBlur={field.onBlur}
                      required
                      disabled={roster.isLoading}
                    >
                      <option value="">{t("transfer.selectPlaceholder")}</option>
                      {roster.data?.employees.map((emp) => (
                        <option key={emp.id} value={emp.id}>{emp.name}</option>
                      ))}
                      {formerEmployee && (
                        <option value={formerEmployee.id}>
                          {t("transfer.formerSuffix", { name: formerEmployee.name })}
                        </option>
                      )}
                    </Select>
                  )}
                />
              </Field>
            </div>
            <p className={styles.note}>{t("transfer.employeeRequiredNote")}</p>
            {roster.isError && <Alert tone="error">{t("transfer.rosterFailed")}</Alert>}
            {!roster.isLoading && !roster.isError && roster.data?.employees.length === 0 && (
              <Empty>{t("transfer.rosterEmpty")}</Empty>
            )}
          </Section>
        </Card>

        {errors.root && <Alert tone="error">{errors.root.message}</Alert>}

        <FormActions guard={guard}>
          <Button
            type="button"
            tone="secondary"
            onClick={() => guard.confirmLeave(() => navigate(cancelTo))}
            disabled={isSubmitting}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={isSubmitting}>
            {isSubmitting ? t("transfer.saving") : submitLabel}
          </Button>
        </FormActions>
      </form>
    </>
  );
}

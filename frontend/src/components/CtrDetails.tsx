// The details a Currency Transaction Report needs about a customer,
// asked for at the counter before the money leaves the drawer (Cash a
// check, review row "CTR details needed") and kept on the customer's
// profile. The SSN / ITIN shows masked; a manager can reveal it, and
// every look is audited.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("CTR").

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  ctrFieldLabel, revealTin, saveCtrDetails, TIN_TYPES, tinTypeLabel,
  type CheckCustomerDetail, type CtrDetailsBody,
} from "../api/checkCashing";
import {
  Alert, Button, Card, DateInput, Field, Input, Modal, ModalActions,
  SectionTitle, Select, useToast,
} from "./ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDate } from "../lib/datetime";
import { hasPermission } from "../lib/permissions";
import styles from "../routes/CheckCashing.module.css";

type Form = Omit<CtrDetailsBody, "gender" | "country"> & { gender: string; country: string };

function startForm(c: CheckCustomerDetail): Form {
  return {
    dob: c.dob ?? "", tin_type: (c.tin_type || "ssn") as Form["tin_type"], tin: "",
    occupation: c.occupation, address: c.address, city: c.city, state: c.state,
    zip_code: c.zip_code, country: c.country || "US", gender: c.gender,
  };
}

/** The popup that fills or corrects a customer's CTR details. */
export function CtrDetailsDialog({
  customer, open, onClose, onSaved,
}: {
  customer: CheckCustomerDetail | null | undefined;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Form | null>(null);
  const [shownFor, setShownFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh form each time the popup opens for a customer.
  if (open && customer && (customer.id !== shownFor || form == null)) {
    setShownFor(customer.id);
    setForm(startForm(customer));
    setError(null);
  }
  if (!open && shownFor != null) {
    setShownFor(null);
    setForm(null);
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const hasTin = Boolean(customer?.tin_masked);
  const ready = form != null && form.dob !== "" && (hasTin || form.tin.trim() !== "")
    && form.occupation.trim() !== "" && form.address.trim() !== ""
    && form.city.trim() !== "" && form.state.trim() !== "" && form.zip_code.trim() !== "";

  async function save() {
    if (!customer || !form) return;
    setBusy(true); setError(null);
    try {
      await saveCtrDetails(customer.id, {
        ...form, tin: form.tin.trim(), state: form.state.trim().toUpperCase(),
        country: form.country.trim().toUpperCase() || "US",
        gender: form.gender as CtrDetailsBody["gender"],
      });
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.ctrDetailsSaved"), tone: "success" });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.ctrDetailsFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open && customer != null} onClose={() => { if (!busy) onClose(); }}
      title={t("checkCashing.ctrDetailsTitle", { name: customer?.full_name ?? "" })}
      size="lg" disabled={busy}
      actions={(
        <ModalActions>
          <Button type="button" tone="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="button" busy={busy} disabled={busy || !ready} onClick={() => { void save(); }}>
            {t("common.save")}
          </Button>
        </ModalActions>
      )}
    >
      <p className={styles.note}>{t("checkCashing.ctrDetailsHint")}</p>
      {form && (
        <div className={styles.fieldGrid}>
          <Field label={t("checkCashing.tinType")}>
            <Select
              value={form.tin_type}
              onChange={(e) => set("tin_type", e.target.value as Form["tin_type"])}
            >
              {TIN_TYPES.map((v) => <option key={v} value={v}>{tinTypeLabel(v)}</option>)}
            </Select>
          </Field>
          <Field
            label={t("checkCashing.tin")}
            hint={hasTin ? t("checkCashing.tinOnFile", { masked: customer?.tin_masked ?? "" }) : undefined}
          >
            <Input
              type="password" autoComplete="off" maxLength={25}
              value={form.tin} onChange={(e) => set("tin", e.target.value)}
            />
          </Field>
          <Field label={t("checkCashing.dob")}>
            <DateInput value={form.dob} required onChange={(e) => set("dob", e.target.value)} />
          </Field>
          <Field label={t("checkCashing.occupation")}>
            <Input
              type="text" maxLength={50}
              value={form.occupation} onChange={(e) => set("occupation", e.target.value)}
            />
          </Field>
          <div className={styles.full}>
            <Field label={t("checkCashing.street")}>
              <Input
                type="text" maxLength={100}
                value={form.address} onChange={(e) => set("address", e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("checkCashing.city")}>
            <Input
              type="text" maxLength={50}
              value={form.city} onChange={(e) => set("city", e.target.value)}
            />
          </Field>
          <Field label={t("checkCashing.state")}>
            <Input
              type="text" maxLength={3}
              value={form.state} onChange={(e) => set("state", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label={t("checkCashing.zip")}>
            <Input
              type="text" maxLength={9}
              value={form.zip_code} onChange={(e) => set("zip_code", e.target.value)}
            />
          </Field>
          <Field label={t("checkCashing.country")} hint={t("checkCashing.countryHint")}>
            <Input
              type="text" maxLength={2}
              value={form.country} onChange={(e) => set("country", e.target.value.toUpperCase())}
            />
          </Field>
          <Field label={t("checkCashing.gender")}>
            <Select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
              <option value="">{t("checkCashing.genderNotSaid")}</option>
              <option value="male">{t("checkCashing.genderMale")}</option>
              <option value="female">{t("checkCashing.genderFemale")}</option>
              <option value="unknown">{t("checkCashing.genderUnknown")}</option>
            </Select>
          </Field>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

/** The masked SSN / ITIN with a manager's Reveal button. */
export function TinValue({ customerId, masked, type }: {
  customerId: number; masked: string; type: string;
}) {
  const t = useT();
  const canReveal = hasPermission("check_cashing_manage", "update");
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!masked) return <span className={styles.muted}>{t("checkCashing.tinNone")}</span>;
  return (
    <span className={styles.tinValue}>
      <span className={styles.mono}>{shown ?? masked}</span>
      <span className={styles.muted}>{tinTypeLabel(type)}</span>
      {canReveal && shown == null && (
        <Button
          type="button" size="sm" tone="secondary"
          onClick={() => {
            setError(null);
            revealTin(customerId).then((r) => setShown(r.tin)).catch((err) => {
              setError(apiErrorMessage(err, t("checkCashing.tinRevealFailed")));
            });
          }}
        >
          {t("checkCashing.tinReveal")}
        </Button>
      )}
      {error && <span className={styles.errorText}>{error}</span>}
    </span>
  );
}

/** The CTR details card on a customer's profile. */
export function CtrDetailsCard({ customer }: { customer: CheckCustomerDetail }) {
  const t = useT();
  const canEdit = hasPermission("check_cashing", "update");
  const [editing, setEditing] = useState(false);
  const place = [customer.address, customer.city, customer.state, customer.zip_code]
    .filter(Boolean).join(", ");
  return (
    <Card>
      <div className={styles.checkHead}>
        <SectionTitle>{t("checkCashing.ctrDetails")}</SectionTitle>
        {canEdit && (
          <Button type="button" size="sm" tone="secondary" onClick={() => setEditing(true)}>
            {t("checkCashing.ctrDetailsEdit")}
          </Button>
        )}
      </div>
      {customer.ctr_missing.length > 0 && (
        <p className={styles.note}>
          {t("checkCashing.ctrMissing", {
            fields: customer.ctr_missing.map(ctrFieldLabel).join(", "),
          })}
        </p>
      )}
      <dl className={styles.factList}>
        <dt>{t("checkCashing.tin")}</dt>
        <dd>
          <TinValue customerId={customer.id} masked={customer.tin_masked} type={customer.tin_type} />
        </dd>
        <dt>{t("checkCashing.dob")}</dt>
        <dd>{customer.dob ? formatDate(customer.dob) : "—"}</dd>
        <dt>{t("checkCashing.occupation")}</dt>
        <dd>{customer.occupation || "—"}</dd>
        <dt>{t("checkCashing.address")}</dt>
        <dd>{place || "—"}</dd>
      </dl>
      <CtrDetailsDialog customer={customer} open={editing} onClose={() => setEditing(false)} />
    </Card>
  );
}

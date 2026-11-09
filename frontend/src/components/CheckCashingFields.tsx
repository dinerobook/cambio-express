// Shared pieces of the check cashing pages: the status pill, the fee
// picker (percent or dollar amount — used by the store settings and by
// the customer and company profiles), the status + own-fee block both
// profiles carry, and the fields of one ID document.
// Rules: api/Modules/CheckCashing/INVARIANTS.md.

import {
  ID_TYPES, PARTY_STATUSES, PARTY_STATUS_TONES, idTypeLabel, partyStatusLabel,
  type CheckCustomerIdBody,
} from "../api/checkCashing";
import { DateInput, Field, Input, MoneyInput, Pill, Select } from "./ui";
import { useT } from "../i18n";
import styles from "../routes/CheckCashing.module.css";

export function PartyStatusPill({ status }: { status: string }) {
  return (
    <Pill tone={PARTY_STATUS_TONES[status] ?? "neutral"} dot>
      {partyStatusLabel(status)}
    </Pill>
  );
}

export type FeeKind = "percent" | "flat";

/** A fee as percent or dollars. `allowNone` adds "Use the next rule"
 *  (an own fee on a profile is optional; the store default is not). */
export function FeeFields({
  kind, value, onChange, allowNone, label,
}: {
  kind: FeeKind | null;
  value: number | null;
  onChange: (kind: FeeKind | null, value: number | null) => void;
  allowNone: boolean;
  label: string;
}) {
  const t = useT();
  return (
    <>
      <Field label={label}>
        <Select
          value={kind ?? ""}
          onChange={(e) => {
            const next = (e.target.value || null) as FeeKind | null;
            onChange(next, next ? (value ?? 0) : null);
          }}
        >
          {allowNone && <option value="">{t("checkCashing.feeNone")}</option>}
          <option value="percent">{t("checkCashing.feePercent")}</option>
          <option value="flat">{t("checkCashing.feeFlat")}</option>
        </Select>
      </Field>
      {/* No own fee → no amount box (a field that does not apply
          disappears rather than showing $0). */}
      {kind && (
        <MoneyInput
          label={kind === "percent" ? t("checkCashing.feeRate") : t("checkCashing.feeAmount")}
          prefix={kind === "percent" ? "%" : "$"}
          value={value ?? 0}
          onChange={(v) => onChange(kind, v)}
        />
      )}
    </>
  );
}

export interface PartyRules {
  status: "normal" | "trusted" | "blocked";
  status_reason: string;
  fee_kind: FeeKind | null;
  fee_value: number | null;
}

/** Status (normal / trusted / blocked + why) and an own fee. Only for
 *  people holding "Manage check cashing"; the page shows the status
 *  pill read-only to everyone else. */
export function PartyRulesFields({
  rules, onChange, feeHint,
}: {
  rules: PartyRules;
  onChange: (rules: PartyRules) => void;
  feeHint: string;
}) {
  const t = useT();
  return (
    <div className={styles.fieldGrid}>
      <Field label={t("checkCashing.status")}>
        <Select
          value={rules.status}
          onChange={(e) => onChange({
            ...rules, status: e.target.value as PartyRules["status"],
          })}
        >
          {PARTY_STATUSES.map((s) => (
            <option key={s} value={s}>{partyStatusLabel(s)}</option>
          ))}
        </Select>
      </Field>
      {rules.status !== "normal" && (
        <Field label={t("checkCashing.statusReason")}>
          <Input
            type="text" maxLength={255}
            value={rules.status_reason}
            onChange={(e) => onChange({ ...rules, status_reason: e.target.value })}
          />
        </Field>
      )}
      <FeeFields
        label={t("checkCashing.ownFee")}
        allowNone
        kind={rules.fee_kind}
        value={rules.fee_value}
        onChange={(fee_kind, fee_value) => onChange({ ...rules, fee_kind, fee_value })}
      />
      <p className={`${styles.note} ${styles.full}`}>{feeHint}</p>
    </div>
  );
}

/** The fields of one ID document. */
export function IdFields({
  value, onChange,
}: {
  value: CheckCustomerIdBody;
  onChange: (value: CheckCustomerIdBody) => void;
}) {
  const t = useT();
  return (
    <div className={styles.fieldGrid}>
      <Field label={t("checkCashing.idType")}>
        <Select
          value={value.id_type}
          onChange={(e) => onChange({
            ...value, id_type: e.target.value as CheckCustomerIdBody["id_type"],
          })}
        >
          {ID_TYPES.map((k) => <option key={k} value={k}>{idTypeLabel(k)}</option>)}
        </Select>
      </Field>
      <Field label={t("checkCashing.idNumber")}>
        <Input
          type="text" required maxLength={60}
          value={value.id_number}
          onChange={(e) => onChange({ ...value, id_number: e.target.value })}
        />
      </Field>
      <Field label={t("checkCashing.idIssuer")} hint={t("checkCashing.idIssuerHint")}>
        <Input
          type="text" maxLength={60}
          value={value.issuer ?? ""}
          onChange={(e) => onChange({ ...value, issuer: e.target.value })}
        />
      </Field>
      <Field label={t("checkCashing.idExpires")}>
        <DateInput
          value={value.expires_on ?? ""}
          onChange={(e) => onChange({ ...value, expires_on: e.target.value || null })}
        />
      </Field>
    </div>
  );
}

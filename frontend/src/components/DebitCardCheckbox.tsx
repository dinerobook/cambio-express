import { Checkbox, fontSize, space, tokens } from "./ui";
import type { PaymentMethod } from "../lib/transferKinds";
import { useT } from "../i18n";

/** "Paid by debit card" on the new + edit transfer forms. A boolean
 *  attribute of the record, so a Checkbox (UI-STANDARDS §1); the form
 *  value stays the API's `payment_method` string. */
export default function DebitCardCheckbox({
  value, onChange, disabled,
}: {
  value: PaymentMethod;
  onChange: (next: PaymentMethod) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div style={{ marginTop: space.md }}>
      <Checkbox
        checked={value === "debit_card"}
        onChange={(checked) => onChange(checked ? "debit_card" : "cash")}
        disabled={disabled}
      >
        {t("transfer.paidByCard")}
        <span style={{
          display: "block",
          fontSize: fontSize.xs,
          color: tokens.textMuted,
        }}>
          {t("transfer.paidByCardHint")}
        </span>
      </Checkbox>
    </div>
  );
}

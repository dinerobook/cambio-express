import { Checkbox, fontSize, space, tokens } from "./ui";
import type { PaymentMethod } from "../lib/transferKinds";

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
  return (
    <div style={{ marginTop: space.md }}>
      <Checkbox
        checked={value === "debit_card"}
        onChange={(checked) => onChange(checked ? "debit_card" : "cash")}
        disabled={disabled}
      >
        Paid by debit card
        <span style={{
          display: "block",
          fontSize: fontSize.xs,
          color: tokens.textMuted,
        }}>
          On the company's card terminal: no cash goes in the drawer, and
          it stays out of this company's cash drop.
        </span>
      </Checkbox>
    </div>
  );
}

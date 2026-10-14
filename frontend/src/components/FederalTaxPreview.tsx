import { previewFederalTax } from "../api/transfers";
import { fmtMoney2 } from "../lib/formatters";
import { Field, Input, space, tokens } from "./ui";

// Read-only client-side preview of the federal tax the server is
// about to compute. Mirrors the rule in
// `api/Modules/Transfers/Services/tax.py` so the cashier can
// sanity-check the number before submit; the actual value still
// comes from the server (CLAUDE.md invariant #9). Shared by the new
// and edit transfer forms. `rate` comes from `useTransferChoices`
// (anyone who may open the form gets it); it used to come from
// store-info, which needs settings.read, so a cashier saw $0.
// A debit card send carries no remittance tax, so the box is not
// shown at all for one (owner's call, 2026-10-14: an always-$0 box
// is wasted space); unticking the card brings it back.
export default function FederalTaxPreview({
  sendAmount, serviceType, country, paymentMethod, rate,
}: {
  sendAmount: number | string;
  serviceType: string;
  country: string;
  paymentMethod: string;
  rate: number;
}) {
  if (paymentMethod === "debit_card") return null;
  const tax = previewFederalTax({
    sendAmount, serviceType, country, paymentMethod, rate,
  });
  const exempt = tax === 0 && (Number(sendAmount) || 0) > 0;
  const pct = (rate * 100).toFixed(rate < 0.01 ? 2 : 0);
  return (
    <Field
      label={
        rate > 0
          ? `Federal tax preview (${pct}%, server recomputes)`
          : "Federal tax preview"
      }
    >
      <Input
        type="text"
        readOnly
        tabIndex={-1}
        value={fmtMoney2(tax)}
        style={{
          background: tokens.surface2,
          color: tokens.textMuted,
          cursor: "default",
          fontFamily: tokens.fontMono,
        }}
      />
      {exempt && (
        <span style={{
          display: "block",
          marginTop: space.xs,
          fontSize: "0.75rem",
          color: tokens.textMuted,
        }}>
          Exempt — {country === "United States"
            ? "domestic recipient"
            : `${serviceType} service`}
        </span>
      )}
    </Field>
  );
}

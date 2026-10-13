// The choices on a transfer, shared by the new and edit forms, the
// list filters, the detail page and the receipt. The service list
// mirrors `SERVICE_TYPES` in api/Modules/Transfers/Services/tax.py.
//
// Two kinds of transfer read differently from a plain cash send:
//   - a debit card send: the customer paid on the company's card
//     terminal, so no cash reached the drawer (`payment_method`);
//   - a payout: the store hands cash to a recipient. On a payout the
//     "sender" fields hold the customer paid at the counter (the person
//     the store identifies and pays) and the "recipient" fields hold
//     who sent the money. See api/Modules/Transfers/INVARIANTS.md.

export const COMPANIES = [
  "Intermex", "Maxi", "Barri", "Sigue", "Vigo", "Western Union",
  "MoneyGram", "Cibao", "RIA", "Other",
] as const;

export const PAYOUT_SERVICE = "Payout";

export const SERVICES = [
  "Money Transfer", "Bill Payment", "Top Up", "Recharge", PAYOUT_SERVICE,
] as const;

export const COUNTRIES = [
  "United States", "Mexico", "Guatemala", "El Salvador", "Honduras",
  "Dominican Republic", "Colombia", "Ecuador", "Peru", "Other",
] as const;

export const STATUSES = ["Sent", "Pending", "Cancelled", "Returned"] as const;

export type PaymentMethod = "cash" | "debit_card";

export function isPayout(serviceType: string | null | undefined): boolean {
  return serviceType === PAYOUT_SERVICE;
}

export function isDebitCard(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === "debit_card";
}

/** Names for the two parties and the amount, which swap meaning on a
 *  payout: the customer at the counter is the one being paid. */
export function transferWording(serviceType: string | null | undefined) {
  return isPayout(serviceType)
    ? {
        customer: "Recipient (paid here)",
        other: "Sent by",
        otherName: "Sender name",
        otherPhone: "Sender phone",
        country: "Sent from",
        amount: "Amount paid out",
        total: "Paid out",
      }
    : {
        customer: "Sender",
        other: "Recipient",
        otherName: "Recipient name",
        otherPhone: "Recipient phone",
        country: "Country",
        amount: "Send amount",
        total: "Total collected",
      };
}

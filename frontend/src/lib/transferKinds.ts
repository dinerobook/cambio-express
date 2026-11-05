// The choices on a transfer, shared by the new and edit forms, the
// list filters, the detail page and the receipt. The service list
// mirrors `SERVICE_TYPES` in api/Modules/Transfers/Services/tax.py.
//
// Companies and countries are NOT here: they are the store's own
// lists from Settings → General (`useTransferChoices`), so the
// transfer form offers the same companies as the MSB daily book.
//
// Two kinds of transfer read differently from a plain cash send:
//   - a debit card send: the customer paid on the company's card
//     terminal, so no cash reached the drawer (`payment_method`);
//   - a payout: the store hands cash to a recipient. On a payout the
//     "sender" fields hold the customer paid at the counter (the person
//     the store identifies and pays) and the "recipient" fields hold
//     who sent the money. See api/Modules/Transfers/INVARIANTS.md.

import { t, type MessageKey } from "../i18n";

export const PAYOUT_SERVICE = "Payout";

export const SERVICES = [
  "Money Transfer", "Bill Payment", "Top Up", "Recharge", PAYOUT_SERVICE,
] as const;

export const STATUSES = ["Sent", "Pending", "Cancelled", "Returned"] as const;

/** What a new transfer form starts on. */
export const DEFAULT_SERVICE = SERVICES[0];
export const DEFAULT_STATUS = STATUSES[0];

// SERVICES and STATUSES are the values the API stores and filters on,
// so they stay English on the wire. The screen shows them through
// serviceLabel / statusLabel (UI-STANDARDS §10).
const SERVICE_KEYS: Record<(typeof SERVICES)[number], MessageKey> = {
  "Money Transfer": "transfer.serviceMoneyTransfer",
  "Bill Payment": "transfer.serviceBillPayment",
  "Top Up": "transfer.serviceTopUp",
  "Recharge": "transfer.serviceRecharge",
  "Payout": "transfer.servicePayout",
};
const STATUS_KEYS: Record<(typeof STATUSES)[number], MessageKey> = {
  Sent: "transfer.statusSent",
  Pending: "transfer.statusPending",
  Cancelled: "transfer.statusCancelled",
  Returned: "transfer.statusReturned",
};

/** A stored service value in the person's language. A value the list
 *  doesn't know (an older row) shows as stored. */
export function serviceLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(SERVICE_KEYS, value)
    ? t(SERVICE_KEYS[value as keyof typeof SERVICE_KEYS])
    : value;
}

/** A stored status value in the person's language. */
export function statusLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return Object.hasOwn(STATUS_KEYS, value)
    ? t(STATUS_KEYS[value as keyof typeof STATUS_KEYS])
    : value;
}

/** The options for a store pick-list (company / country) on a form
 *  that holds `current`. A saved transfer or batch keeps the value it
 *  was saved with even after Settings drops it, so editing never
 *  silently swaps it: that value is offered after the store's list. */
export function choicesWith(
  list: readonly string[], current: string | null | undefined,
): string[] {
  return current && !list.includes(current) ? [...list, current] : [...list];
}

/** The country a new transfer starts on: Mexico while the store's
 *  list has it (what the form always defaulted to), else the first. */
export function defaultCountry(countries: readonly string[]): string {
  const preferred = "Mexico";
  return countries.includes(preferred) ? preferred : (countries[0] ?? "");
}

export type PaymentMethod = "cash" | "debit_card";

export function isPayout(serviceType: string | null | undefined): boolean {
  return serviceType === PAYOUT_SERVICE;
}

export function isDebitCard(paymentMethod: string | null | undefined): boolean {
  return paymentMethod === "debit_card";
}

/** Names for the two parties and the amount, which swap meaning on a
 *  payout: the customer at the counter is the one being paid. */
// Already in the person's language: call it during render of a
// component that uses useT(), so a language change re-renders it.
export function transferWording(serviceType: string | null | undefined) {
  return isPayout(serviceType)
    ? {
        customer: t("transfer.payoutCustomer"),
        other: t("transfer.payoutOther"),
        otherName: t("transfer.payoutOtherName"),
        otherPhone: t("transfer.payoutOtherPhone"),
        country: t("transfer.payoutCountry"),
        amount: t("transfer.payoutAmount"),
        total: t("transfer.payoutTotal"),
      }
    : {
        customer: t("transfer.sender"),
        other: t("transfer.recipient"),
        otherName: t("transfer.recipientName"),
        otherPhone: t("transfer.recipientPhone"),
        country: t("transfer.country"),
        amount: t("transfer.sendAmount"),
        total: t("transfer.totalCollected"),
      };
}

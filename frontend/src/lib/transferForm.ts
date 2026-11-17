// The money transfer form's values: one schema and the two ways a
// form starts (a blank new transfer, or a stored one being edited).
// The form itself is `components/TransferForm.tsx`, shared by
// NewTransfer and EditTransfer. Rules: api/Modules/Transfers/INVARIANTS.md.

import { z } from "zod";

import type { TransferDetail } from "../api/transfers";
import { todayIso } from "./datetime";
import {
  DEFAULT_SERVICE, DEFAULT_STATUS, SERVICES, STATUSES,
} from "./transferKinds";

// Mirrors ``api/Modules/Transfers/Requests/CreateTransferRequest``.
// The server is still the source of truth: Zod here gives instant
// feedback and types the form. Messages are translator keys, shown
// with tIfKey() so they read in the person's language when shown.
export const transferSchema = z.object({
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

  // MoneyInput hands the form numbers, so no coercion is needed.
  send_amount: z.number().positive("transfer.amountPositive"),
  fee: z.number().min(0, "transfer.feeNotNegative"),
  confirm_number: z.string(),

  // Required: the "— Select —" option surfaces as a field error.
  employee_id: z
    .number({ message: "transfer.pickEmployee" })
    .int()
    .positive(),
});

export type TransferFormValues = z.infer<typeof transferSchema>;

/** A blank new transfer, dated today (worked out when the form opens,
 *  so a tab left open overnight does not start on yesterday).
 *  Company and country start empty: the form moves them onto the
 *  store's lists once those load. */
export function newTransferValues(): TransferFormValues {
  return {
    send_date: todayIso(),
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
    // No one picked yet: forces the validator to fire.
    employee_id: undefined as unknown as number,
  };
}

/** A stored transfer as form values. Every field the full-row PUT
 *  replaces is read back, so saving an edit never blanks what the
 *  operator did not touch (the fields with no input on the form —
 *  commission, notes, batch — are sent back by EditTransfer). */
export function transferValuesFrom(row: TransferDetail): TransferFormValues {
  return {
    send_date: row.send_date,
    // Company + country stay exactly as saved, even when Settings
    // has since dropped them (StoreListField still offers them).
    company: row.company,
    service_type: (SERVICES as readonly string[]).includes(row.service_type)
      ? (row.service_type as (typeof SERVICES)[number])
      : DEFAULT_SERVICE,
    // A row saved before payment method existed is cash.
    payment_method: row.payment_method === "debit_card" ? "debit_card" : "cash",
    status: (STATUSES as readonly string[]).includes(row.status)
      ? (row.status as (typeof STATUSES)[number])
      : DEFAULT_STATUS,
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
  };
}

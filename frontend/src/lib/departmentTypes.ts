// A department's type, as the person sees it (Account → Departments and
// the Modisoft department import). The values are the server's
// `DEPARTMENT_TYPES`; the groups are Modisoft's five department types,
// whose `key` matches the import's `type_group`.
import type { DepartmentType } from "../api/dayclose";
import type { MessageKey } from "../i18n";

export type TypeGroupKey = "merchandise" | "fuel" | "lottery" | "services" | "misc";

// The type picker, grouped the way Modisoft groups department types.
export const TYPE_GROUPS: { key: TypeGroupKey; label: MessageKey; types: DepartmentType[] }[] = [
  { key: "merchandise", label: "dept.group.merchandise", types: ["merchandise"] },
  { key: "fuel", label: "dept.group.fuel", types: ["fuel"] },
  { key: "lottery", label: "dept.group.lottery", types: ["lottery_sell", "lottery_cash", "lotto_sell", "lotto_cash"] },
  {
    key: "services",
    label: "dept.group.services",
    types: [
      "money_order", "money_order_fee", "money_transfer",
      "money_transfer_fee", "check_cash_fee", "service",
    ],
  },
  { key: "misc", label: "dept.group.misc", types: ["misc"] },
];

export const TYPE_LABEL: Record<DepartmentType, MessageKey> = {
  merchandise: "dept.type.merchandise",
  fuel: "dept.type.fuel",
  lottery_sell: "dept.type.lottery_sell",
  lottery_cash: "dept.type.lottery_cash",
  lotto_sell: "dept.type.lotto_sell",
  lotto_cash: "dept.type.lotto_cash",
  money_order: "dept.type.money_order",
  money_order_fee: "dept.type.money_order_fee",
  money_transfer: "dept.type.money_transfer",
  money_transfer_fee: "dept.type.money_transfer_fee",
  check_cash_fee: "dept.type.check_cash_fee",
  service: "dept.type.service",
  misc: "dept.type.misc",
};

// One line under the picker: what a department of this type holds.
export const TYPE_HINT: Record<DepartmentType, MessageKey> = {
  merchandise: "dept.typeHint.merchandise",
  fuel: "dept.typeHint.fuel",
  lottery_sell: "dept.typeHint.lottery_sell",
  lottery_cash: "dept.typeHint.lottery_cash",
  lotto_sell: "dept.typeHint.lotto_sell",
  lotto_cash: "dept.typeHint.lotto_cash",
  money_order: "dept.typeHint.money_order",
  money_order_fee: "dept.typeHint.money_order_fee",
  money_transfer: "dept.typeHint.money_transfer",
  money_transfer_fee: "dept.typeHint.money_transfer_fee",
  check_cash_fee: "dept.typeHint.check_cash_fee",
  service: "dept.typeHint.service",
  misc: "dept.typeHint.misc",
};

/** A stored rate (a fraction, 0.0825) as the percent a person types
 *  and reads ("8.25"): up to four decimals, no trailing zeros. */
export function ratePercentText(rate: number): string {
  return String(Number((rate * 100).toFixed(4)));
}

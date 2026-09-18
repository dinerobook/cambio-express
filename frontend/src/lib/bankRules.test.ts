import { describe, expect, it } from "vitest";

import type { BankRuleRow } from "../api/bankSync";
import {
  bodyFromFormValues, conditionChips, EMPTY_RULE_FORM, formValuesFromRule,
  postOffsetLabel, ruleSentence,
} from "./bankRules";

const base: BankRuleRow = {
  id: 1, enabled: true, priority: 10,
  desc_match_type: "contains", desc_match_value: "REMOTE DEPOSIT",
  sign_filter: "credit", amount_min_cents: null, amount_max_cents: null,
  account_filter_id: null, account_filter_label: "",
  target_kind: "check_deposit", auto_post: true, post_date_offset_days: 0,
  description: "RDC batches", match_count: 3, last_matched_at: "",
};

describe("conditionChips / ruleSentence", () => {
  it("reads a rule as an if-sentence", () => {
    const labels = new Map([["check_deposit", "Check Deposit"]]);
    expect(conditionChips(base)).toEqual([
      ["description", "contains", "“REMOTE DEPOSIT”"],
      ["money in"],
    ]);
    expect(ruleSentence(base, labels))
      .toBe("RDC batches: if description contains “REMOTE DEPOSIT” and money in → Check Deposit");
  });

  it("renders an amount range and an account pin", () => {
    const r = { ...base, amount_min_cents: 100000, amount_max_cents: 500000, account_filter_id: 4, account_filter_label: "Ops ••0230" };
    expect(conditionChips(r)).toContainEqual(["amount", "between", "$1,000.00", "and", "$5,000.00"]);
    expect(conditionChips(r)).toContainEqual(["account", "is", "Ops ••0230"]);
  });

  it("names an unconditional rule for what it is", () => {
    const r = { ...base, desc_match_type: "", desc_match_value: "", sign_filter: "" };
    expect(conditionChips(r)).toEqual([["any transaction"]]);
  });
});

describe("postOffsetLabel", () => {
  it("names the shift in the operator's words", () => {
    expect(postOffsetLabel(0)).toBe("The bank's own date");
    expect(postOffsetLabel(-1)).toBe("1 day before the bank's date");
    expect(postOffsetLabel(2)).toBe("2 days after the bank's date");
    // Outside the picker's options but inside what the API accepts.
    expect(postOffsetLabel(-10)).toBe("10 days before the bank's date");
  });
});

describe("form values ↔ API body", () => {
  it("round-trips a rule row through the form", () => {
    const body = bodyFromFormValues(formValuesFromRule(base));
    expect(body).toMatchObject({
      desc_match_type: "contains", desc_match_value: "REMOTE DEPOSIT",
      sign_filter: "credit", amount_min_cents: null, amount_max_cents: null,
      target_kind: "check_deposit", auto_post: true, apply_to_existing: false,
    });
  });

  it("carries the booking-day shift both ways", () => {
    const form = formValuesFromRule({ ...base, post_date_offset_days: -1 });
    expect(form.post_date_offset_days).toBe(-1);
    expect(bodyFromFormValues(form).post_date_offset_days).toBe(-1);
    // A rule row from before the column existed reads as no shift.
    expect(
      formValuesFromRule({ ...base, post_date_offset_days: undefined as unknown as number })
        .post_date_offset_days,
    ).toBe(0);
  });

  it("drops the match type when no text was typed, converts dollars to cents", () => {
    const body = bodyFromFormValues({
      ...EMPTY_RULE_FORM, desc_match_value: "  ", amount_min: 12.34, target_kind: "ignore",
    });
    expect(body.desc_match_type).toBe("");
    expect(body.amount_min_cents).toBe(1234);
    expect(body.amount_max_cents).toBeNull();
    expect(body.apply_to_existing).toBe(true);
  });
});

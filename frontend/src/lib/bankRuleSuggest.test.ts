import { describe, expect, it } from "vitest";

import { matchTextFromDescription, suggestRuleFor } from "./bankRuleSuggest";

describe("matchTextFromDescription", () => {
  it("drops a trailing date so the rule fires on the next statement", () => {
    expect(matchTextFromDescription("REMOTE DEPOSIT FEE 04/29"))
      .toBe("REMOTE DEPOSIT FEE");
  });

  it("drops reference numbers and card suffixes", () => {
    expect(matchTextFromDescription("ACH DEBIT INTERMEX 8834412"))
      .toBe("ACH DEBIT INTERMEX");
    expect(matchTextFromDescription("POS PURCHASE CARD#1234 SHELL OIL"))
      .toBe("POS PURCHASE SHELL OIL");
  });

  it("collapses whitespace and trailing separators", () => {
    expect(matchTextFromDescription("  MOBILE DEPOSIT  -  2026-05-06  "))
      .toBe("MOBILE DEPOSIT");
  });

  it("keeps a description that is only a reference number", () => {
    expect(matchTextFromDescription("8834412")).toBe("8834412");
  });
});

describe("suggestRuleFor", () => {
  it("takes the sign from the amount", () => {
    expect(suggestRuleFor({ description: "FEE", amount_cents: -210 }).sign_filter)
      .toBe("debit");
    expect(suggestRuleFor({ description: "DEPOSIT", amount_cents: 5000 }).sign_filter)
      .toBe("credit");
  });

  it("always suggests a contains match", () => {
    expect(suggestRuleFor({ description: "X 1", amount_cents: 1 }))
      .toEqual({ desc_match_type: "contains", desc_match_value: "X", sign_filter: "credit" });
  });
});

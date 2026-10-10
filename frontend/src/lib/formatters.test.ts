import { describe, expect, it } from "vitest";

import { fmtDelta, fmtHours, fmtMoney, fmtMoney2, fmtNumber } from "./formatters";

describe("fmtMoney2", () => {
  it("keeps thousands separators (the toFixed(2) bypass lost them)", () => {
    expect(fmtMoney2(12345.67)).toBe("$12,345.67");
    expect(fmtMoney2(5)).toBe("$5.00");
  });

  it("renders zero, null, undefined and non-finite as $0.00", () => {
    expect(fmtMoney2(0)).toBe("$0.00");
    expect(fmtMoney2(null)).toBe("$0.00");
    expect(fmtMoney2(undefined)).toBe("$0.00");
    expect(fmtMoney2(Number.NaN)).toBe("$0.00");
  });

  it("puts a negative sign before the dollar sign", () => {
    expect(fmtMoney2(-50.5)).toBe("-$50.50");
    expect(fmtMoney2(-1234.5)).toBe("-$1,234.50");
    expect(fmtMoney2(-0.001)).toBe("$0.00");
  });
});

describe("fmtMoney", () => {
  it("rounds to whole dollars with separators", () => {
    expect(fmtMoney(1234.6)).toBe("$1,235");
    expect(fmtMoney(1234567)).toBe("$1,234,567");
  });

  it("renders zero, null and undefined as $0", () => {
    expect(fmtMoney(0)).toBe("$0");
    expect(fmtMoney(null)).toBe("$0");
    expect(fmtMoney(undefined)).toBe("$0");
  });

  it("puts a negative sign before the dollar sign", () => {
    expect(fmtMoney(-1234.4)).toBe("-$1,234");
    expect(fmtMoney(-0.4)).toBe("$0");
  });
});

describe("fmtNumber", () => {
  it("groups thousands and drops decimals", () => {
    expect(fmtNumber(1234)).toBe("1,234");
    expect(fmtNumber(-1234)).toBe("-1,234");
    expect(fmtNumber(0)).toBe("0");
    expect(fmtNumber(null)).toBe("0");
  });
});

describe("fmtDelta", () => {
  it("money: arrow up, then the size through fmtMoney", () => {
    expect(fmtDelta(1234.4, "money")).toBe("▲ $1,234");
  });

  it("money: arrow down, size without a minus sign", () => {
    expect(fmtDelta(-1234.6, "money")).toBe("▼ $1,235");
  });

  it("count: arrow plus a grouped integer", () => {
    expect(fmtDelta(1500)).toBe("▲ 1,500");
    expect(fmtDelta(-3, "count")).toBe("▼ 3");
  });

  it("zero reads as up", () => {
    expect(fmtDelta(0)).toBe("▲ 0");
    expect(fmtDelta(0, "money")).toBe("▲ $0");
  });

  it("is empty when there is no number", () => {
    expect(fmtDelta(null)).toBe("");
    expect(fmtDelta(undefined, "money")).toBe("");
    expect(fmtDelta(Number.NaN)).toBe("");
  });
});

describe("fmtHours", () => {
  it("shows two decimals", () => {
    expect(fmtHours(7.5)).toBe("7.50");
    expect(fmtHours(8)).toBe("8.00");
    expect(fmtHours(0)).toBe("0.00");
    expect(fmtHours(-1.25)).toBe("-1.25");
  });

  it("shows an em dash when there is no figure yet", () => {
    expect(fmtHours(null)).toBe("—");
    expect(fmtHours(undefined)).toBe("—");
  });
});

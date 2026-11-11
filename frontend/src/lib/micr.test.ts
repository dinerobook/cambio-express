import { describe, expect, it } from "vitest";

import { abaRoutingValid, parseMicrLine } from "./micr";

describe("abaRoutingValid", () => {
  it("passes a real routing number and fails a mistyped one", () => {
    expect(abaRoutingValid("111000025")).toBe(true);
    expect(abaRoutingValid("111000026")).toBe(false);
    expect(abaRoutingValid("11100002")).toBe(false);
    expect(abaRoutingValid("11100002x")).toBe(false);
  });
});

describe("parseMicrLine", () => {
  it("reads a personal check with the real symbols", () => {
    expect(parseMicrLine("⑆111000025⑆ 4400123456⑈ 0232")).toEqual({
      routing: "111000025", account: "4400123456", number: "232",
      amountCents: null, routingValid: true,
    });
  });

  it("reads a business check with its number first", () => {
    expect(parseMicrLine("⑈010232⑈ ⑆111000025⑆ 4400123456⑈")).toMatchObject({
      routing: "111000025", account: "4400123456", number: "10232",
    });
  });

  it("takes the typed stand-ins for the symbols", () => {
    expect(parseMicrLine("U010232U T111000025T 4400123456U")).toMatchObject({
      routing: "111000025", account: "4400123456", number: "10232",
    });
    expect(parseMicrLine("a111000025a 44-00123456c 1001")).toMatchObject({
      routing: "111000025", account: "4400123456", number: "1001",
    });
  });

  it("reads a line typed with spaces only", () => {
    expect(parseMicrLine("111000025 4400123456 232")).toMatchObject({
      routing: "111000025", account: "4400123456", number: "232",
    });
    expect(parseMicrLine("232 111000025 4400123456")).toMatchObject({
      routing: "111000025", account: "4400123456", number: "232",
    });
  });

  it("takes a short group before the account as the check number", () => {
    expect(parseMicrLine("T111000025T 1001 4400123456U")).toMatchObject({
      account: "4400123456", number: "1001",
    });
  });

  it("reads the amount field when it is printed", () => {
    expect(parseMicrLine("T111000025T 4400123456U 232 $0000175000$")).toMatchObject({
      number: "232", amountCents: 175000,
    });
  });

  it("flags a routing number that fails the check digit", () => {
    expect(parseMicrLine("T111000026T 4400123456U 232")).toMatchObject({
      routing: "111000026", routingValid: false,
    });
  });

  it("prefers the nine digits that pass the check digit", () => {
    expect(parseMicrLine("123456789 111000025 4400123456")).toMatchObject({
      routing: "111000025", number: "123456789", account: "4400123456",
    });
  });

  it("returns null without a routing number", () => {
    expect(parseMicrLine("")).toBeNull();
    expect(parseMicrLine("4400123456 232")).toBeNull();
  });
});

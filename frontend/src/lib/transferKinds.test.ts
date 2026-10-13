import { describe, expect, it } from "vitest";

import {
  choicesWith, defaultCountry, isDebitCard, isPayout, transferWording,
} from "./transferKinds";

describe("choicesWith", () => {
  it("is the store's list when the value is on it or empty", () => {
    expect(choicesWith(["Intermex", "Maxi"], "Maxi")).toEqual(["Intermex", "Maxi"]);
    expect(choicesWith(["Intermex"], "")).toEqual(["Intermex"]);
    expect(choicesWith([], null)).toEqual([]);
  });

  it("offers a saved value Settings has dropped, after the list", () => {
    expect(choicesWith(["Intermex"], "Vigo")).toEqual(["Intermex", "Vigo"]);
  });

  it("never changes the store's list", () => {
    const list = ["Intermex"];
    choicesWith(list, "Vigo");
    expect(list).toEqual(["Intermex"]);
  });
});

describe("defaultCountry", () => {
  it("is Mexico while the list has it, else the first, else blank", () => {
    expect(defaultCountry(["United States", "Mexico"])).toBe("Mexico");
    expect(defaultCountry(["Cuba", "Peru"])).toBe("Cuba");
    expect(defaultCountry([])).toBe("");
  });
});

describe("transfer kinds", () => {
  it("tells payouts and debit card sends apart", () => {
    expect(isPayout("Payout")).toBe(true);
    expect(isPayout("Money Transfer")).toBe(false);
    expect(isDebitCard("debit_card")).toBe(true);
    expect(isDebitCard(null)).toBe(false);
    expect(transferWording("Payout").country).toBe("Sent from");
    expect(transferWording("Money Transfer").country).toBe("Country");
  });
});

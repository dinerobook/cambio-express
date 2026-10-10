import { describe, expect, it } from "vitest";
import { ApiError, apiErrorMessage } from "./api";

describe("apiErrorMessage", () => {
  it("returns the server's message for an ApiError", () => {
    expect(apiErrorMessage(new ApiError(409, "Day is locked.", null), "fb"))
      .toBe("Day is locked.");
  });

  it("falls back when an ApiError has no message", () => {
    expect(apiErrorMessage(new ApiError(500, "", null), "fb")).toBe("fb");
  });

  it("hides a plain Error's text by default (Failed to fetch, parse errors)", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"), "fb")).toBe("fb");
  });

  it("surfaces a plain Error's text with anyError", () => {
    expect(
      apiErrorMessage(new Error("Passkey creation was cancelled."), "fb",
        { anyError: true }),
    ).toBe("Passkey creation was cancelled.");
    expect(apiErrorMessage(new Error(""), "fb", { anyError: true })).toBe("fb");
  });

  it("falls back for non-errors", () => {
    expect(apiErrorMessage("boom", "fb")).toBe("fb");
    expect(apiErrorMessage(undefined, "fb", { anyError: true })).toBe("fb");
    expect(apiErrorMessage(null, "")).toBe("");
  });
});

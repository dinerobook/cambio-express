import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  getLanguage, initLanguageFromDevice, intlLocale, isLanguage,
  reconcileLanguage, setLanguage, t, useT,
} from "./index";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { translateServerMessage, SERVER_MESSAGES } from "./serverMessages";
import { ApiError, apiErrorMessage } from "../lib/api";
import { formatDate, formatTime } from "../lib/datetime";
import { fmtMoney2 } from "../lib/formatters";

// The translator's contract (UI-STANDARDS §10): English by default
// and unchanged, Spanish only when a person picks it, every key in
// both languages with the same placeholders.

const KEYS = Object.keys(en) as MessageKey[];

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

// Words that are the same in both languages on purpose.
const SAME_IN_BOTH: MessageKey[] = ["login.copyright"];

describe("word lists", () => {
  it("has a Spanish entry for every English key and nothing extra", () => {
    expect(Object.keys(es).sort()).toEqual([...KEYS].sort());
  });

  it("never leaves a Spanish entry empty", () => {
    expect(KEYS.filter((k) => !es[k].trim())).toEqual([]);
  });

  it("keeps the same {placeholders} in both languages", () => {
    const off = KEYS.filter(
      (k) => placeholders(en[k]).join() !== placeholders(es[k]).join(),
    );
    expect(off).toEqual([]);
  });

  it("actually translates (no English copied into Spanish)", () => {
    const copied = KEYS.filter(
      (k) => en[k] === es[k] && !SAME_IN_BOTH.includes(k),
    );
    expect(copied).toEqual([]);
  });

  it("never calls the store Admin a super admin in Spanish", () => {
    expect(Object.values(es).filter((v) => /super\s*admin/i.test(v)))
      .toEqual([]);
  });
});

describe("current language", () => {
  it("is English by default", () => {
    expect(getLanguage()).toBe("en");
    expect(t("login.title")).toBe("Sign in");
    expect(intlLocale()).toBe("en-US");
  });

  it("switches to Spanish, marks the page and remembers the device", () => {
    setLanguage("es");
    expect(t("login.title")).toBe("Iniciar sesión");
    expect(document.documentElement.getAttribute("lang")).toBe("es");
    expect(window.localStorage.getItem("dinerobook.language")).toBe("es");
    expect(intlLocale()).toBe("es-US");
    setLanguage("en");
    expect(t("login.title")).toBe("Sign in");
    expect(document.documentElement.getAttribute("lang")).toBe("en");
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(t("pager.showing", { first: 1, last: 25, total: 90 }))
      .toBe("Showing 1–25 of 90");
    setLanguage("es");
    expect(t("pager.showing", { first: 1, last: 25, total: 90 }))
      .toBe("Mostrando 1–25 de 90");
    expect(t("pager.showing", { first: 1 })).toBe("Mostrando 1–{last} de {total}");
  });

  it("restores the device's choice, ignoring anything unknown", () => {
    window.localStorage.setItem("dinerobook.language", "fr");
    initLanguageFromDevice();
    expect(getLanguage()).toBe("en");
    window.localStorage.setItem("dinerobook.language", "es");
    initLanguageFromDevice();
    expect(getLanguage()).toBe("es");
  });

  it("does not follow the browser's language (English stays the default)", () => {
    const spy = Object.getOwnPropertyDescriptor(window.navigator, "language");
    Object.defineProperty(window.navigator, "language", {
      value: "es-MX", configurable: true,
    });
    initLanguageFromDevice();
    expect(getLanguage()).toBe("en");
    if (spy) Object.defineProperty(window.navigator, "language", spy);
  });

  it("lets the profile's choice win, and ignores a missing one", () => {
    setLanguage("es");
    reconcileLanguage(undefined);
    expect(getLanguage()).toBe("es");
    reconcileLanguage("de");
    expect(getLanguage()).toBe("es");
    // Never chosen: keep what the device shows.
    reconcileLanguage(null);
    expect(getLanguage()).toBe("es");
    reconcileLanguage("en");
    expect(getLanguage()).toBe("en");
  });

  it("recognises only the two languages", () => {
    expect(isLanguage("en")).toBe(true);
    expect(isLanguage("es")).toBe(true);
    expect(isLanguage("EN")).toBe(false);
    expect(isLanguage(null)).toBe(false);
  });

  it("re-renders components that read words through useT", () => {
    function Title() {
      const tr = useT();
      return <h1>{tr("login.title")}</h1>;
    }
    render(<Title />);
    expect(screen.getByRole("heading")).toHaveTextContent("Sign in");
    act(() => setLanguage("es"));
    expect(screen.getByRole("heading")).toHaveTextContent("Iniciar sesión");
  });
});

describe("server messages", () => {
  it("leaves every server sentence untouched in English", () => {
    for (const msg of Object.keys(SERVER_MESSAGES)) {
      expect(translateServerMessage(msg, 401)).toBe(msg);
    }
    expect(translateServerMessage("Rate limit exceeded", 429))
      .toBe("Rate limit exceeded");
  });

  it("translates known sentences in Spanish and keeps unknown ones", () => {
    setLanguage("es");
    expect(translateServerMessage("Invalid username or password", 401))
      .toBe("Usuario o contraseña incorrectos");
    expect(translateServerMessage("Something new from the server", 400))
      .toBe("Something new from the server");
    expect(translateServerMessage("Rate limit exceeded: 10 per 1 minute", 429))
      .toBe(es["common.tooManyAttempts"]);
  });

  it("maps every listed sentence to a real key", () => {
    for (const key of Object.values(SERVER_MESSAGES)) {
      expect(KEYS).toContain(key);
    }
  });

  it("flows through apiErrorMessage", () => {
    const err = new ApiError(401, "Invalid username or password", {});
    expect(apiErrorMessage(err, "x")).toBe("Invalid username or password");
    setLanguage("es");
    expect(apiErrorMessage(err, "x")).toBe("Usuario o contraseña incorrectos");
    // The caller's fallback is passed through as given.
    expect(apiErrorMessage(new Error("boom"), t("common.networkError")))
      .toBe("Error de red. Inténtelo de nuevo.");
  });
});

describe("dates and money", () => {
  it("keeps English dates exactly as before", () => {
    expect(formatDate("2026-11-02")).toBe("Nov 2, 2026");
  });

  it("uses Spanish words for dates in Spanish, same calendar day", () => {
    setLanguage("es");
    expect(formatDate("2026-11-02")).toMatch(/^2 nov 2026$/);
  });

  it("keeps the store's timezone in Spanish", () => {
    const iso = "2026-11-02T18:30:00";  // naive UTC from the API
    const en = formatTime(iso, { timeZone: "America/Chicago" });
    setLanguage("es");
    const es = formatTime(iso, { timeZone: "America/Chicago" });
    expect(en).toMatch(/^12:30/);
    expect(es).toMatch(/^12:30/);
  });

  it("keeps US money punctuation in both languages", () => {
    expect(fmtMoney2(1234.5)).toBe("$1,234.50");
    setLanguage("es");
    expect(fmtMoney2(1234.5)).toBe("$1,234.50");
  });
});

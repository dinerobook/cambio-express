import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  getLanguage, initLanguageFromDevice, intlLocale, isLanguage,
  reconcileLanguage, setLanguage, t, tIfKey, tn, tNodes, useT,
} from "./index";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { translateServerMessage, SERVER_MESSAGES } from "./serverMessages";
import { ApiError, apiErrorMessage } from "../lib/api";
import {
  formatDate, formatMonthYear, formatTime, monthName, weekdayNameLong,
  weekdayNamesShort,
} from "../lib/datetime";
import { batchStatusLabel } from "../api/batches";
import { paymentMethodLabel, returnCheckStatusLabel } from "../api/returnChecks";
import {
  PAYOUT_SERVICE, SERVICES, STATUSES, serviceLabel, statusLabel,
  transferWording,
} from "../lib/transferKinds";
import { fmtMoney2 } from "../lib/formatters";

// The translator's contract (UI-STANDARDS §10): English by default
// and unchanged, Spanish only when a person picks it, every key in
// both languages with the same placeholders.

const KEYS = Object.keys(en) as MessageKey[];

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

// Words that are the same in both languages on purpose.
const SAME_IN_BOTH: MessageKey[] = [
  "login.copyright",
  // A brand name, and words Spanish spells the same.
  "daily.boostMobile", "daily.total", "daily.totalCaps", "daily.totalLabel",
  "transfer.total", "returnCheck.methodZelle",
  // Only placeholders and symbols: "{count} {label}", "{label} (USD)".
  "daily.countOpen", "transfer.inUsd", "transfer.outOfHoursOpen",
];

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

describe("counts and month words", () => {
  it("tn picks the plural form by the language's rules", () => {
    expect(tn("daily.entries", 0)).toBe("0 entries");
    expect(tn("daily.entries", 1)).toBe("1 entry");
    expect(tn("daily.entries", 1234, (n) => n.toLocaleString("en-US")))
      .toBe("1,234 entries");
    act(() => setLanguage("es"));
    expect(tn("daily.entries", 1)).toBe("1 entrada");
    expect(tn("daily.entries", 2)).toBe("2 entradas");
    expect(tn("daily.entries", 0)).toBe("0 entradas");
  });

  it("every .one key has its .other twin", () => {
    const keys = Object.keys(en);
    const ones = keys.filter((k) => k.endsWith(".one"));
    expect(ones.length).toBeGreaterThan(0);
    for (const k of ones) expect(keys).toContain(k.replace(/\.one$/, ".other"));
  });

  it("month headings and weekdays follow the language", () => {
    expect(formatMonthYear(2026, 10)).toBe("October 2026");
    expect(weekdayNamesShort()).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    act(() => setLanguage("es"));
    expect(formatMonthYear(2026, 10)).toBe("octubre de 2026");
    expect(weekdayNamesShort()[0]).toMatch(/^dom/);
  });

  it("every listed server sentence comes back in Spanish", () => {
    act(() => setLanguage("es"));
    for (const [sentence, key] of Object.entries(SERVER_MESSAGES)) {
      expect(translateServerMessage(sentence, 400)).toBe(es[key]);
    }
    expect(translateServerMessage("Something else", 400)).toBe("Something else");
    expect(translateServerMessage("constructor", 400)).toBe("constructor");
  });
});

describe("stored values and form errors", () => {
  it("shows stored services and statuses in the language, never changing them", () => {
    expect(SERVICES.map(serviceLabel)).toEqual([...SERVICES]);
    expect(STATUSES.map(statusLabel)).toEqual([...STATUSES]);
    act(() => setLanguage("es"));
    expect(serviceLabel("Money Transfer")).toBe("Envío de dinero");
    expect(serviceLabel(PAYOUT_SERVICE)).toBe("Pago a beneficiario");
    expect(statusLabel("Sent")).toBe("Enviado");
    // A value from an older row or another system is shown as stored.
    expect(serviceLabel("Western Union Plus")).toBe("Western Union Plus");
    expect(statusLabel("")).toBe("—");
    expect(serviceLabel(null)).toBe("—");
  });

  it("re-reads the transfer wording each call", () => {
    expect(transferWording("Money Transfer").customer).toBe("Sender");
    act(() => setLanguage("es"));
    expect(transferWording("Money Transfer").customer).toBe("Remitente");
    expect(transferWording(PAYOUT_SERVICE).amount).toBe("Monto pagado");
  });

  it("tIfKey translates a key and passes other text through", () => {
    expect(tIfKey(undefined)).toBeUndefined();
    expect(tIfKey("transfer.nameRequired")).toBe("Name is required");
    expect(tIfKey("Something typed by hand")).toBe("Something typed by hand");
    expect(tIfKey("constructor")).toBe("constructor");
    expect(serviceLabel("toString")).toBe("toString");
    act(() => setLanguage("es"));
    expect(tIfKey("transfer.nameRequired")).toBe("El nombre es obligatorio");
  });

  it("names a weekday in full in the language, Monday first", () => {
    expect(weekdayNameLong(0)).toBe("Monday");
    expect(weekdayNameLong(6)).toBe("Sunday");
    act(() => setLanguage("es"));
    expect(weekdayNameLong(0)).toBe("lunes");
    expect(weekdayNameLong(5)).toBe("sábado");
  });
});

describe("markup inside a sentence and more stored values", () => {
  it("tNodes keeps the sentence whole and puts each node in its place", () => {
    const { container } = render(
      <p>{tNodes("customer.selectedTwo", { winner: <b>Ana</b>, loser: <b>Luis</b> })}</p>,
    );
    expect(container.textContent).toBe("Selected: Ana (winner) ← Luis (loser)");
    expect(container.querySelectorAll("b")).toHaveLength(2);
    act(() => setLanguage("es"));
    const es = render(
      <p>{tNodes("customer.selectedTwo", { winner: <b>Ana</b>, loser: <b>Luis</b> })}</p>,
    );
    expect(es.container.textContent).toBe("Seleccionados: Ana (se queda) ← Luis (se elimina)");
  });

  it("tNodes leaves an unknown placeholder visible", () => {
    const { container } = render(<p>{tNodes("customer.selectedOne", {})}</p>);
    expect(container.textContent).toContain("{winner}");
  });

  it("month names follow the language", () => {
    expect(monthName(11)).toBe("November");
    expect(monthName(5, "short")).toBe("May");
    act(() => setLanguage("es"));
    expect(monthName(11)).toBe("noviembre");
    expect(monthName(11, "short")).toBe("nov");
  });

  it("batch and returned-check values read in Spanish, unknown ones as stored", () => {
    expect(batchStatusLabel("Cleared")).toBe("Cleared");
    expect(returnCheckStatusLabel("pending")).toBe("Pending");
    expect(paymentMethodLabel("money_order")).toBe("Money order");
    act(() => setLanguage("es"));
    expect(batchStatusLabel("Cleared")).toBe("Acreditado");
    expect(returnCheckStatusLabel("fraud")).toBe("Fraude");
    expect(paymentMethodLabel("money_order")).toBe("Giro postal");
    expect(batchStatusLabel("Bounced twice")).toBe("Bounced twice");
    expect(paymentMethodLabel("constructor")).toBe("constructor");
    expect(returnCheckStatusLabel(null)).toBe("—");
  });
});

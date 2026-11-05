// The app's words in English and Spanish (UI-STANDARDS §10).
//
// One small in-house translator, no library:
//   • `en.ts` is the source of truth: every English string a covered
//     screen shows, under a dotted key ("login.title").
//   • `es.ts` is typed against it, so a key missing from Spanish, or a
//     typo in a key passed to `t()`, fails `npm run build`.
//   • `{name}` placeholders are filled by `t(key, { name })`; never
//     glue translated pieces together, word order differs.
//
// The current language is module state, like the display timezone in
// lib/datetime.ts: set once from the device cache before first paint,
// then from the person's profile (the server wins, exactly like the
// theme). `useT()` re-renders a component when it changes.
//
// English is the default everywhere. A person who never picks Spanish
// sees exactly the app they saw before this file existed.

import { useSyncExternalStore } from "react";

import { en, type MessageKey } from "./en";
import { es } from "./es";

export type { MessageKey } from "./en";

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Each language named in its own words — never translated, so a
 *  person who can't read the current language still finds theirs. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  es: "Español",
};

const CATALOGS: Record<Language, Record<MessageKey, string>> = { en, es };

/** BCP 47 locale for `Intl` date words. Both are US locales on
 *  purpose: es-US keeps US number punctuation ($1,234.56), so
 *  amounts match receipts and bank statements in either language. */
const INTL_LOCALES: Record<Language, string> = { en: "en-US", es: "es-US" };

const STORAGE_KEY = "dinerobook.language";

export function isLanguage(v: unknown): v is Language {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

let current: Language = "en";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function intlLocale(): string {
  return INTL_LOCALES[current];
}

/** Switch the app's language now, remember it on this device, and
 *  re-render every component that reads words through `useT()`. */
export function setLanguage(lang: Language): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage blocked — the switch still applies to this page */
  }
  if (lang === current) return;
  current = lang;
  document.documentElement.setAttribute("lang", lang);
  listeners.forEach((fn) => fn());
}

/** Before first paint: the device's last choice, else English. The
 *  browser's own language is NOT used — English stays the default
 *  until a person picks Spanish. */
export function initLanguageFromDevice(): void {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
  if (isLanguage(stored)) setLanguage(stored);
}

/** After the profile loads: the person's saved choice wins over the
 *  device cache, so the language follows them to every device. A
 *  person who never chose (null) keeps what this device shows, so
 *  pressing ES on the sign-in screen carries on after sign-in. */
export function reconcileLanguage(
  serverPreference: string | null | undefined,
): void {
  if (isLanguage(serverPreference)) setLanguage(serverPreference);
}

export type MessageVars = Record<string, string | number>;

function fill(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The current language's words for `key`, placeholders filled. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return fill(CATALOGS[current][key] || en[key], vars);
}

export type Translate = typeof t;

/** For a message that may be a key: a form schema's error (zod keeps
 *  the text it was built with, so schemas store keys) or a field's
 *  own text. A key is translated; anything else passes through. */
export function tIfKey(message: string | undefined): string | undefined {
  // Own keys only: "constructor" is `in` every object.
  return message !== undefined && Object.hasOwn(en, message)
    ? t(message as MessageKey)
    : message;
}

/** Keys that come in a `.one` / `.other` pair ("daily.entries.one"). */
export type PluralBase = {
  [K in MessageKey]: K extends `${infer B}.one`
    ? (`${B}.other` extends MessageKey ? B : never)
    : never;
}[MessageKey];

/** A count with its noun in the current language: `tn("daily.entries",
 *  3)` → "3 entries" / "3 entradas". `{count}` is filled with the
 *  number as `fmt` writes it (the caller passes `fmtNumber`, so the
 *  thousands separator matches every other count). */
export function tn(
  base: PluralBase, count: number, fmt: (n: number) => string = String,
  vars?: MessageVars,
): string {
  const form = new Intl.PluralRules(INTL_LOCALES[current]).select(count);
  const key = (form === "one" ? `${base}.one` : `${base}.other`) as MessageKey;
  return t(key, { ...vars, count: fmt(count) });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The current language; re-renders the caller when it changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** `t` for a component: same function, but the component re-renders
 *  when the language changes. Use this in every covered screen. */
export function useT(): Translate {
  useLanguage();
  return t;
}

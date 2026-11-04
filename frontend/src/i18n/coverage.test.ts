import { describe, expect, it } from "vitest";

import { en } from "./en";

// Translation guard (UI-STANDARDS §10). Every file listed here has
// been moved onto the translator: its visible words come from
// `t(...)` (i18n/en.ts + es.ts), never typed in English directly.
// A covered file that gains a raw English string fails here.
//
// Moving another screen into Spanish = translate it, then add its
// file to COVERED_FILES. Files leave this list only by being deleted.
export const COVERED_FILES = [
  // Sign-in
  "routes/Login.tsx",
  "routes/LoginStore.tsx",
  "routes/ForgotPassword.tsx",
  "routes/ResetPassword.tsx",
  "components/AuthChrome.tsx",
  "components/LanguageSwitch.tsx",
  // App shell
  "components/AppShell.tsx",
  "components/SlimSidebar.tsx",
  "components/UserMenu.tsx",
  "components/ThemeToggle.tsx",
  "components/NotificationBell.tsx",
  "components/UnsavedChangesHost.tsx",
  "components/PageCrumbs.tsx",
  // Kit pieces every screen shows
  "components/ui/Breadcrumbs.tsx",
  "components/ui/FormActions.tsx",
  "components/ui/Loading.tsx",
  "components/ui/Pager.tsx",
  "components/ui/MonthCalendar.tsx",
  "components/ui/PeriodStepper.tsx",
  // Daily book
  "routes/DailyBook.tsx",
  "routes/EditDailyBook.tsx",
  "routes/DailyBookSettlements.tsx",
  "routes/DailyBookTile.tsx",
];

const sources = import.meta.glob(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function source(file: string): string {
  const key = Object.keys(sources).find((p) => p.endsWith(`/${file}`));
  if (!key) throw new Error(`covered file missing: ${file}`);
  return sources[key];
}

/** Source without comments, so prose in comments never trips it. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// Text that is not a word to translate: symbols, numbers, the brand.
const NOT_WORDS = /^[\s$·|—–•…←→✓#%0-9.,:()+-]*$|^\$$|^DineroBook$/;
// Examples that read the same in every language.
const EXAMPLE = /^[\w.+-]+@[\w-]+\.[\w.]+$|^\+?[\d ()-]+$/;

function rawStrings(src: string): string[] {
  const body = code(src);
  const found: string[] = [];
  // JSX text between tags: >Sign in<
  // `(?<!=)`: an arrow's `=>` is code (`() => Promise<void>`), not a tag.
  for (const m of body.matchAll(/(?<!=)>([^<>{}]*[A-Za-z]{2}[^<>{}]*)</g)) {
    const text = m[1].trim();
    // Skip TypeScript, not JSX: generics and comparisons like
    // `useState<X | null>(null); … <` contain code punctuation.
    if (/[;=()&|]|=>/.test(text)) continue;
    if (!NOT_WORDS.test(text)) found.push(text);
  }
  // Visible attributes: label="…", placeholder="…", title="…", …
  for (const m of body.matchAll(
    /\b(label|placeholder|title|aria-label|alt|confirmLabel|cancelLabel|message)="([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    if (!EXAMPLE.test(m[2])) found.push(`${m[1]}="${m[2]}"`);
  }
  // Object-literal labels and error setters: label: "…", setError("…")
  for (const m of body.matchAll(
    /\b(label|title|message):\s*"([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    // A config table naming its words by translator key is fine.
    if (!(m[2] in en)) found.push(`${m[1]}: "${m[2]}"`);
  }
  for (const m of body.matchAll(
    /\b(setError|setMsg|apiErrorMessage\([^,]+,)\s*\(?\s*"([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    found.push(`${m[1]}("${m[2]}")`);
  }
  // A ternary between two English words: busy ? "Saving…" : "Save"
  // (capitalised, so CSS classes and option values don't count).
  for (const m of body.matchAll(/[?:]\s*"([A-Z][^"]*[a-z]{2}[^"]*)"/g)) {
    found.push(`branch "${m[1]}"`);
  }
  return found;
}

describe("translation guard", () => {
  it("finds every covered file", () => {
    for (const f of COVERED_FILES) expect(() => source(f)).not.toThrow();
  });

  it.each(COVERED_FILES)("%s shows no raw English", (file) => {
    expect(rawStrings(source(file))).toEqual([]);
  });

  it("catches the patterns it is meant to catch", () => {
    // Self-test: a guard that matches nothing guards nothing.
    const sample = [
      `<h2 className={x}>Sign in</h2>`,
      `<Field label="Email or phone">`,
      `navLink={{ to: "/x", label: "Create an account" }}`,
      `setError("Passwords do not match.");`,
      `{busy ? "Saving…" : "Save changes"}`,
    ].join("\n");
    expect(rawStrings(sample)).toHaveLength(7);
    expect(rawStrings(`<h2>{t("login.title")}</h2> // Sign in`)).toEqual([]);
  });
});

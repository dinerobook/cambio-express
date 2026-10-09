import { describe, expect, it } from "vitest";

// Source ratchets for patterns UI-STANDARDS bans and that kept
// coming back as hand-rolled copies. Each one has a shared helper;
// a new copy fails here and names the helper to use instead.

const sources = import.meta.glob(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  return Object.entries(sources)
    .filter(([path]) => !allow.some((a) => path.endsWith(a)))
    .filter(([, src]) => pattern.test(src))
    .map(([path]) => path);
}

describe("source guards", () => {
  it("finds the source tree", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
  });

  it("never derives a calendar day from the UTC clock", () => {
    // `toISOString().slice(0, 10)` names the UTC day: tomorrow for a
    // US store after ~7pm. Use todayIso / toIsoDate / daysAgoIso.
    expect(
      offenders(/toISOString\(\)\s*\.(slice\(0,\s*10\)|split\("T"\))/,
        ["/datetime.ts"]),
    ).toEqual([]);
  });

  it("keeps one copy of the local-day helpers", () => {
    expect(offenders(/toLocaleDateString\("en-CA"\)/)).toEqual([]);
    expect(
      offenders(/function\s+(todayIso|localToday|_?isoDate|_?daysAgo)\s*\(/,
        ["/datetime.ts"]),
    ).toEqual([]);
  });

  it("renders dates and times through lib/datetime", () => {
    // `toLocaleDateString()` / `toLocaleTimeString()` render on the
    // DEVICE's clock, and `new Date(apiString)` reads the server's
    // offset-less UTC timestamps as local time (a 10:00 lock in
    // Chicago showed 3:00 PM). Use formatDate / formatDateTime /
    // formatTime / formatTimestamp, and parseTimestamp to compare.
    expect(
      offenders(/toLocale(Date|Time)String\(/, ["/datetime.ts"]),
    ).toEqual([]);
    expect(
      offenders(/new Date\([\w.?]*(_at|At|iso)\)/, ["/datetime.ts"]),
    ).toEqual([]);
    expect(
      offenders(/_at\??\.(slice\(0,\s*1[069]\)|replace\("T")/),
    ).toEqual([]);
  });

  it("reads datetime-local inputs on the store clock", () => {
    // `new Date(inputValue).toISOString()` reads the field on the
    // device's clock; zonedInputToUtcIso reads it on the store's.
    expect(
      offenders(/new Date\((clock\w*|schedule\w*|\w*Local)\)\.toISOString/),
    ).toEqual([]);
  });

  it("keeps one copy of the month names", () => {
    expect(offenders(/"January",\s*"February"/, ["/datetime.ts"])).toEqual([]);
    expect(offenders(/"Jan",\s*"Feb"/, ["/datetime.ts"])).toEqual([]);
  });

  it("formats money through fmtMoney / fmtMoney2", () => {
    // `$${n.toLocaleString()}` / `$${n.toFixed(2)}` are private
    // clones of the formatters (UI-STANDARDS §4). A 4-decimal unit
    // cost (toFixed(4)) is a deliberate exception.
    expect(
      offenders(/\$\$\{[^}]*(toLocaleString\(|toFixed\([0-2]\))/,
        ["/formatters.ts"]),
    ).toEqual([]);
  });

  it("uses DateInput, never a raw date input", () => {
    expect(offenders(/type="date"/, ["/DateInput.tsx"])).toEqual([]);
  });

  it("toasts API errors through useApiErrorToast", () => {
    // toast({ message: err instanceof ApiError ? err.message : "…",
    // tone: "error" }) is what useApiErrorToast(err, "…") does.
    expect(
      offenders(
        /toast\(\{\s*message:\s*(\w+) instanceof ApiError\s*\?\s*\1\.message\s*:\s*"[^"]*",\s*tone:\s*"error",?\s*\}\)/,
      ),
    ).toEqual([]);
  });
});

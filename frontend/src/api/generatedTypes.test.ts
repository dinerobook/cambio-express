import { describe, expect, it } from "vitest";

import openapiSrc from "./openapi.d.ts?raw";

// Request / response shapes come from the generated `openapi.d.ts`
// (frontend/CLAUDE.md → "OpenAPI → TypeScript types"). A hand-written
// interface named after a server schema is a second copy that drifts —
// `BankRuleApplyReport` had lost the `matched` count the server sends.

const sources = import.meta.glob(
  ["./*.ts", "!./*.test.ts", "!./*.d.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const schemaBlock = openapiSrc.slice(openapiSrc.indexOf("    schemas: {"));
const SCHEMAS = new Set(
  [...schemaBlock.matchAll(/^ {8}(\w+): \{/gm)].map((m) => m[1]),
);

// Kept by hand on purpose. Each entry says why; remove it when the
// reason goes away.
const KEEP: Record<string, string> = {
  // Pydantic defaults make these fields optional in the generated
  // type, but the server always sends them and the pages read them.
  "timeclock.ts TimeClockEntryRow": "defaulted fields",
  "timeclock.ts TimeClockStatusResponse": "defaulted fields",
  "timeclock.ts TimeClockEntryList": "holds TimeClockEntryRow",
  "bankSync.ts BankCategoryGroup": "defaulted fields",
  "bankSync.ts BankTransactionListResponse": "holds BankTransactionRow",
  "customers.ts CustomerSearchResponse": "defaulted fields",
  // Narrows `books_status` to its literal values, which the server
  // types as a plain string.
  "bankSync.ts BankTransactionRow": "literal union",
  // A different shape that happens to share the name (report drill-
  // down totals carry `amount` / `rules`).
  "reportDrilldown.ts AggregatedTotals": "different shape",
};

describe("generated API types", () => {
  it("finds the generated schemas", () => {
    expect(SCHEMAS.size).toBeGreaterThan(300);
    expect(SCHEMAS.has("TransferRow")).toBe(true);
  });

  it("never hand-writes an interface the server already describes", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(sources)) {
      const file = path.replace("./", "");
      for (const m of src.matchAll(/^export interface (\w+)/gm)) {
        const key = `${file} ${m[1]}`;
        if (SCHEMAS.has(m[1]) && !(key in KEEP)) offenders.push(key);
      }
    }
    expect(offenders, 'use components["schemas"][...] from ./openapi').toEqual([]);
  });

  it("keeps no stale exceptions", () => {
    const stale = Object.keys(KEEP).filter((key) => {
      const [file, name] = key.split(" ");
      const src = sources[`./${file}`] ?? "";
      return !new RegExp(`^export interface ${name}\\b`, "m").test(src);
    });
    expect(stale).toEqual([]);
  });
});

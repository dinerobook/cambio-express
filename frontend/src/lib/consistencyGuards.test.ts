import { describe, expect, it } from "vitest";

import { NAV } from "../components/navConfig";
import shellCss from "../styles.css?raw";
import shellSrc from "../components/AppShell.tsx?raw";

// Ratchets for the cross-page standards set by the 2026-10-21
// consistency sweep (UI-STANDARDS §2, §7b, §10). Each failure names
// the file and the rule; the fix is in the standard, not here.

const sources = import.meta.glob(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const appSource = sources["../App.tsx"];

// Words that keep their capital inside a sentence-case label:
// acronyms, product and company names.
const PROPER = new Set([
  "MSB", "ACH", "P&L", "TV", "Fire", "DineroBook", "Intermex", "Maxi",
  "Barri", "US", "Stripe", "CSV", "PDF", "JSON", "ID", "2FA", "SMS", "EBT",
  "POS", "MRR", "ARR", "I",
]);

/** The words of `label` that break sentence case. */
function titleCased(label: string): string[] {
  return label
    .split(/\s+/)
    // the first WORD keeps its capital ("+ New batch", "% Change")
    .slice(label.split(/\s+/).findIndex((w) => /[A-Za-z]/.test(w)) + 1)
    .map((w) => w.replace(/^[("'“]+|[)"'”.,:!?]+$/g, ""))
    .filter((w) => /^[A-Z][a-z]/.test(w) && !PROPER.has(w));
}

function offending(pattern: RegExp, files: [string, string][]): string[] {
  const out: string[] = [];
  for (const [path, src] of files) {
    for (const m of src.matchAll(pattern)) {
      if (titleCased(m[1]).length) out.push(`${path}: "${m[1]}"`);
    }
  }
  return out;
}

const routeFiles = Object.entries(sources).filter(([p]) =>
  p.startsWith("../routes/") || p.startsWith("../components/"));

describe("sentence case", () => {
  it("names every sidebar section and item in sentence case", () => {
    const bad = NAV.flatMap((g) => [g.title, ...g.items.map((i) => i.label)])
      .filter((l) => titleCased(l).length);
    expect(bad).toEqual([]);
  });

  it("titles every page in sentence case", () => {
    expect(
      offending(/<PageHeader[^>]*?\btitle=\{?"([^"]+)"/gs, routeFiles),
    ).toEqual([]);
  });

  it("labels report titles, KPIs and columns in sentence case", () => {
    const reports = routeFiles.filter(([p]) => p.includes("/routes/reports/"));
    expect(offending(/\b(?:title|label)[=:]\s*"([^"]+)"/g, reports)).toEqual([]);
  });

  it("labels fields, buttons and table headers in sentence case", () => {
    expect(
      offending(/<Field\s[^>]*?\blabel="([^"]+)"/gs, routeFiles),
    ).toEqual([]);
    expect(offending(/\bheader:\s*"([^"]+)"/g, routeFiles)).toEqual([]);
    expect(
      offending(/<(?:Button|ButtonLink)\b[^>]*>\s*([A-Z+][^<{]*?)\s*<\//g, routeFiles),
    ).toEqual([]);
    // the same for a label picked by a ternary: {busy ? "Saving…" : "Save changes"}
    const picked: string[] = [];
    for (const [path, src] of routeFiles) {
      for (const m of src.matchAll(/<(?:Button|ButtonLink)\b[^>]*>\s*\{([^{}]*(?:\([^{}]*\))?[^{}]*)\}\s*<\//g)) {
        for (const lit of m[1].matchAll(/"([^"]+)"/g)) {
          if (titleCased(lit[1]).length) picked.push(`${path}: "${lit[1]}"`);
        }
      }
    }
    expect(picked).toEqual([]);
  });

  it("titles the dashboards in sentence case", () => {
    expect(offending(/(?:\?|:)\s*"([A-Z][a-z]+ [A-Za-z]+)"\s*(?::|;)/g,
      routeFiles.filter(([p]) => p.endsWith("/Dashboard.tsx")))).toEqual([]);
  });
});

describe("one name per page", () => {
  // Every sidebar item opens a page whose title IS the item's label.
  const lazyImports = new Map<string, string>();
  for (const m of appSource.matchAll(/const (\w+) = lazy\(\s*\(\) => import\("\.\/([^"]+)"\),?\s*\)/g)) {
    lazyImports.set(m[1], m[2]);
  }
  for (const m of appSource.matchAll(/import (\w+) from "\.\/([^"]+)";/g)) {
    lazyImports.set(m[1], m[2]);
  }
  const routeComponent = new Map<string, string>();
  for (const m of appSource.matchAll(/path="([^"]+)"[^>]*element=\{(?:<\w+[^>]*>\s*)*<(\w+)/g)) {
    const path = `/${m[1].replace(/^\//, "")}`;
    if (!routeComponent.has(path)) routeComponent.set(path, m[2]);
  }

  const cases = NAV.flatMap((g) => g.items).map((item) => {
    const path = item.to.split("?")[0];
    const comp = routeComponent.get(path);
    const file = comp ? lazyImports.get(comp) : undefined;
    const src = file ? sources[`../${file}.tsx`] : undefined;
    const titles = src
      ? [...src.matchAll(/<PageHeader[^>]*?\btitle=\{?"([^"]+)"/gs)].map((t) => t[1])
      : [];
    const centre = src?.match(/<ReportCenter\b[^>]*?title=\{"([^"]+)"\}/)?.[1];
    return { item: item.label, path, titles: centre ? [centre] : titles, src };
  });

  it("resolves every sidebar item to its page", () => {
    expect(cases.filter((c) => !c.src).map((c) => c.path)).toEqual([]);
  });

  it.each(cases.filter((c) => c.titles.length))(
    "$path is titled \"$item\" like its sidebar link",
    ({ item, titles }) => {
      for (const t of titles) expect(t).toBe(item);
    },
  );
});

describe("page trail", () => {
  it("builds every trail from the sidebar through PageCrumbs", () => {
    const hand = routeFiles
      .filter(([p]) => !p.endsWith("/PageCrumbs.tsx") && !p.includes("/components/ui/"))
      .filter(([, src]) => /<Breadcrumbs\b/.test(src))
      .map(([p]) => p);
    expect(hand).toEqual([]);
  });

  it("puts the trail on every page that has a page header", () => {
    // Dashboards are where you land, hubs are the sections themselves,
    // and sign-in pages have no sidebar.
    const exempt = [
      "/Dashboard.tsx", "/SectionHub.tsx", "/ReportCenter.tsx",
      "/Subscribe.tsx", "/SubscribeSuccess.tsx",
    ];
    const missing = routeFiles
      .filter(([p]) => !p.includes("/components/ui/"))
      .filter(([p]) => !exempt.some((e) => p.endsWith(e)))
      .filter(([, src]) => /<PageHeader\b/.test(src) && !/<PageCrumbs\b/.test(src))
      .map(([p]) => p);
    expect(missing).toEqual([]);
  });
});

describe("popups and forms", () => {
  const dialogs = routeFiles.flatMap(([path, src]) =>
    [...src.matchAll(/<ConfirmDialog\b[\s\S]*?\n\s*\/>/g)].map((m) => ({ path, block: m[0] })),
  );

  it("finds the confirm popups", () => {
    expect(dialogs.length).toBeGreaterThan(30);
  });

  it("colours every destructive confirm button red", () => {
    const bad = dialogs
      .filter((d) => /confirmLabel=\{?"(Delete|Remove|Disconnect|Revoke|Deactivate|Unlink|Unpair)/.test(d.block))
      .filter((d) => !/confirmTone="danger"/.test(d.block))
      .map((d) => d.path);
    expect(bad).toEqual([]);
  });

  it("asks a destructive confirm as a question", () => {
    const bad = dialogs
      .map((d) => ({ ...d, title: d.block.match(/title=(?:"([^"]+)"|\{`([^`]+)`\})/)?.slice(1).find(Boolean) }))
      .filter((d) => d.title && /^(Delete|Remove|Disconnect|Revoke|Deactivate|Unlink|Unpair|Lock)\b/.test(d.title))
      .filter((d) => !d.title!.trim().endsWith("?"))
      .map((d) => `${d.path}: ${d.title}`);
    expect(bad).toEqual([]);
  });

  it("builds every popup button row from ModalActions", () => {
    // `.modalActions` CSS copies and inline right-aligned flex rows were
    // 14 hand-made versions of the kit's row.
    expect(
      routeFiles
        .filter(([, src]) => /styles\.modalActions|justifyContent: "flex-end", gap: "0\.5rem"/.test(src))
        .map(([p]) => p),
    ).toEqual([]);
  });

  it("opens in-app pages with the router, not a full page load", () => {
    // `href="/transfers"` reloads the whole app (and drops its cache);
    // `to="/transfers"` is a router link.
    expect(
      routeFiles
        .filter(([, src]) => /<(ButtonLink|AppLink)\s[^>]*href=(\{`|")\//.test(src))
        .map(([p]) => p),
    ).toEqual([]);
  });

  it("calls signing out Sign out", () => {
    expect(
      routeFiles.filter(([, src]) => />\s*Log out\s*</.test(src)).map(([p]) => p),
    ).toEqual([]);
  });
});

describe("counts", () => {
  it("formats counts through fmtNumber / fmtCount", () => {
    // A bare toLocaleString() picks its own rounding and skips the
    // plural; quantities that can be fractional are the exception.
    const allow = [
      "/formatters.ts", "/ItemMovement.tsx", "/StoreBookMonth.tsx",
      "/TransactionDetail.tsx", "/SuperadminBIDrilldown.tsx",
    ];
    expect(
      Object.entries(sources)
        .filter(([p]) => !allow.some((a) => p.endsWith(a)))
        .filter(([, src]) => /\.toLocaleString\(\)/.test(src))
        .map(([p]) => p),
    ).toEqual([]);
  });

  it("never hand-writes a plural", () => {
    expect(
      Object.entries(sources)
        .filter(([, src]) => /=== 1 \? "[a-z]+" : "[a-z]+"/.test(src))
        .map(([p]) => p),
    ).toEqual([]);
  });
});


describe("phone top bar", () => {
  // A 466px-wide top bar (store name + trial chip + icons) widened
  // every page past a 375px phone screen (2026-10-21).
  const phone = shellCss.slice(shellCss.indexOf("@media (max-width: 768px)"));

  it("never lets a child widen the page column", () => {
    expect(phone).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("lets the store name give way instead of the screen", () => {
    expect(phone).toMatch(/\.app-topbar > \* \{ flex-shrink: 0; \}/);
    expect(phone).toMatch(/\.app-topbar > \.app-store-chip \{ flex-shrink: 1; \}/);
    expect(shellCss).toMatch(/\.app-store-chip-label \{[^}]*text-overflow: ellipsis/);
    expect(shellSrc).toContain('<span className="app-store-chip-label">{label}</span>');
  });

  it("keeps the referral badge named when its amount is hidden", () => {
    expect(shellCss).toMatch(/\.app-referral-badge-amount \{\s*display: none;/);
    expect(shellSrc).toContain('aria-label="Referrals: earn $100"');
  });
});

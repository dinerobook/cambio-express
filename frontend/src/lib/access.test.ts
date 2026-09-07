import { describe, it, expect } from "vitest";

import {
  ROUTE_ACCESS, canAccessWith, findAccess, normalisePath,
} from "./access";
import { NAV } from "../components/navConfig";
// Vite serves the source as a string — no node fs needed in jsdom.
import appSource from "../App.tsx?raw";

// The rule under test: no access, no control. A control may only
// be shown when its destination is reachable, and that is only
// enforceable when the router and every link read ONE table. These
// tests pin the table's semantics and — the important part — fail
// when a route exists that the table does not cover.

const employee = {
  role: "employee",
  permissions: [
    "transfers.read", "transfers.create", "customers.read",
    "daily_book.read", "time_clock.read", "time_clock.create",
    "lottery.read", "day_close.read", "catalog.read",
  ],
};
const admin = { role: "admin", permissions: ["settings.read", "settings.update", "users.read", "time_clock.read"] };
const owner = { role: "owner", permissions: ["settings.read", "settings.update", "time_clock.read"] };
const superadmin = { role: "superadmin", permissions: [] };

describe("normalisePath", () => {
  it("strips the /app basename, query and hash", () => {
    expect(normalisePath("/app/transfers?page=2")).toBe("/transfers");
    expect(normalisePath("/daily/edit?date=2026-01-01#x")).toBe("/daily/edit");
    expect(normalisePath("transfers")).toBe("/transfers");
  });
});

describe("canAccessWith", () => {
  it("gates on the permission the route needs", () => {
    expect(canAccessWith(employee, "/transfers")).toBe(true);
    expect(canAccessWith(employee, "/transfers/new")).toBe(true);
    expect(canAccessWith(employee, "/transfers/12/edit")).toBe(false);
    expect(canAccessWith(employee, "/batches")).toBe(false);
  });

  it("superadmin passes every permission gate", () => {
    expect(canAccessWith(superadmin, "/batches")).toBe(true);
    expect(canAccessWith(superadmin, "/daily/edit")).toBe(true);
  });

  it("role lists are exact — superadmin only where listed", () => {
    expect(canAccessWith(superadmin, "/owner/locations")).toBe(true);
    expect(canAccessWith(superadmin, "/settings/billing")).toBe(false);
    expect(canAccessWith(owner, "/settings/billing")).toBe(false);
    expect(canAccessWith(admin, "/settings/billing")).toBe(true);
  });

  it("the reported bug: an employee cannot reach Billing, General or Referrals", () => {
    expect(canAccessWith(employee, "/settings/billing")).toBe(false);
    expect(canAccessWith(employee, "/settings/general")).toBe(false);
    expect(canAccessWith(employee, "/settings/referrals")).toBe(false);
    expect(canAccessWith(employee, "/settings/profile")).toBe(true);
    expect(canAccessWith(employee, "/settings/security")).toBe(true);
  });

  it("an employee cannot pay, so /subscribe is closed to them", () => {
    expect(canAccessWith(employee, "/subscribe")).toBe(false);
    expect(canAccessWith(admin, "/subscribe")).toBe(true);
  });

  it("payroll is management-only even though employees hold time_clock.read", () => {
    expect(canAccessWith(employee, "/timeclock")).toBe(true);
    expect(canAccessWith(employee, "/admin/timeclock")).toBe(false);
    expect(canAccessWith(employee, "/admin/timeclock/schedule")).toBe(false);
    expect(canAccessWith(admin, "/admin/timeclock/schedule")).toBe(true);
  });

  it("unlisted targets are not gated (public pages, downloads)", () => {
    expect(canAccessWith(employee, "/privacy")).toBe(true);
    expect(canAccessWith(null, "/privacy")).toBe(true);
  });

  it("a listed route with no identity is closed", () => {
    expect(canAccessWith(null, "/dashboard")).toBe(false);
  });

  it("more specific patterns win over splats", () => {
    expect(findAccess("/superadmin/tickets")?.roles).toContain("support");
    expect(findAccess("/superadmin/stores")?.roles).toEqual(["superadmin"]);
  });
});

// ── Coverage: every authed route in App.tsx has an entry ───────

function authedRoutePaths(): string[] {
  const src = appSource;
  const start = src.indexOf("<Route element={<AuthedShell />}>");
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start);
  const paths: string[] = [];
  const stack: string[] = [];
  // Depth 1 is the AuthedShell layout route itself; its closing
  // </Route> ends the walk.
  let depth = 1;
  for (const line of body.split("\n").slice(1)) {
    const m = line.match(/<Route path="([^"]+)"/);
    if (m) {
      const full = [...stack, m[1]].join("/");
      // Redirects and index routes carry no page of their own.
      if (!/element=\{<Navigate/.test(line)) paths.push("/" + full);
      // A <Route …> that is not self-closed on this line nests.
      if (!/\/>\s*$/.test(line)) { stack.push(m[1]); depth++; }
    }
    const closes = line.match(/<\/Route>/g)?.length ?? 0;
    for (let i = 0; i < closes; i++) {
      depth--;
      if (depth === 0) return paths;
      stack.pop();
    }
  }
  return paths;
}

describe("ROUTE_ACCESS covers App.tsx", () => {
  const paths = authedRoutePaths();

  it("finds the routes (sanity)", () => {
    expect(paths.length).toBeGreaterThan(100);
    expect(paths).toContain("/settings/billing");
    expect(paths).toContain("/tv-display/device");
  });

  // The in-shell 404 catch-all is the one route with no page to gate.
  for (const p of paths.filter((x) => x !== "/*")) {
    it(`has an entry for ${p}`, () => {
      expect(findAccess(p)).toBeDefined();
    });
  }

  it("every table entry points at a real route", () => {
    for (const entry of ROUTE_ACCESS) {
      const probe = entry.path.replace(/\*$/, "probe");
      const hit = paths.some((p) => {
        // Compare pattern-to-pattern loosely: same segment count and
        // literal segments equal; params/splats match anything.
        const a = probe.split("/"); const b = p.split("/");
        if (entry.path.endsWith("*")) return p.startsWith(entry.path.slice(0, -1));
        if (a.length !== b.length) return false;
        return a.every((seg, i) => seg.startsWith(":") || b[i].startsWith(":") || seg === b[i]);
      });
      expect(hit, `${entry.path} has no route`).toBe(true);
    }
  });
});

describe("NAV targets are all in the table", () => {
  for (const g of NAV) {
    for (const item of [...g.items, ...(g.to ? [{ to: g.to, label: g.title }] : [])]) {
      it(`${item.label} → ${item.to}`, () => {
        expect(findAccess(item.to)).toBeDefined();
      });
    }
  }
});

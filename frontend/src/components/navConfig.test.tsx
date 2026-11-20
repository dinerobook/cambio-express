import { describe, it, expect } from "vitest";

import {
  CHECK_DESK_FLAG, CHECK_HOME, filterNavForRole, navTrail, sectionSlug,
} from "./navConfig";
import { TEST_ADMIN } from "../test/setup";

describe("sectionSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(sectionSlug("Daily")).toBe("daily");
    expect(sectionSlug("Sub Department")).toBe("sub-department");
  });

  it("strips leading/trailing separators and collapses runs", () => {
    expect(sectionSlug("  Reports & P&L  ")).toBe("reports-p-l");
  });
});

describe("filterNavForRole → section-hub resolution", () => {
  // The /hub/:key route resolves a section by matching sectionSlug on
  // the current role's filtered groups. That only works if the slugs
  // are unique per role — this is the guard against a future rename
  // that collides two sections and makes a hub ambiguous.
  for (const role of ["admin", "employee", "owner", "superadmin"]) {
    it(`produces unique section slugs for ${role}`, () => {
      const groups = filterNavForRole(role, []);
      const slugs = groups.map((g) => sectionSlug(g.title));
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it(`drops empty groups for ${role} (no blank hubs)`, () => {
      const groups = filterNavForRole(role, []);
      // Every surviving group is either a real menu (has items) or a
      // direct-link group (has `to`, e.g. Reports → Report Center).
      // What we never want is a group with neither — a blank hub.
      for (const g of groups) {
        expect(g.items.length > 0 || !!g.to).toBe(true);
      }
    });
  }

  it("Developer shows only while a superadmin is signed in as the store", () => {
    // Owner, 2026-11-20: a store tab, seen only on an impersonation.
    const titles = (role: string, impersonating?: boolean) =>
      filterNavForRole(role, [], undefined, "backoffice", impersonating)
        .map((g) => g.title);
    for (const role of ["admin", "employee", "owner", "superadmin", "accountant"]) {
      expect(titles(role)).not.toContain("Developer");
    }
    const dev = filterNavForRole("admin", [], undefined, "backoffice", true)
      .find((g) => g.title === "Developer");
    expect(dev?.to).toBe("/developer/files");
    expect(titles("employee", true)).toContain("Developer");
    // An impersonated owner outside a store, or check cashing view: no.
    expect(titles("owner", true)).not.toContain("Developer");
    expect(filterNavForRole("admin", [], undefined, "checks", true).map((g) => g.title))
      .not.toContain("Developer");
    // Its trail reads "Developer / <file>" on the file page.
    const trail = navTrail("/developer/files/7",
      filterNavForRole("admin", [], undefined, "backoffice", true));
    expect(trail.map((c) => c.label)).toEqual(["Developer"]);
  });

  it("each business carries its own reports; an admin has no Reports menu", () => {
    // Owner, 2026-11-19: MSB reports sit in MSB, Store reports in
    // Retail (sidebar option 2). Reports is the accountant's menu.
    const groups = filterNavForRole(
      "admin", ["reports.read", "check_cashing.read"],
      ["module_day_close", CHECK_DESK_FLAG],
    );
    const items = (title: string) =>
      groups.find((g) => g.title === title)?.items.map((i) => i.label);
    expect(items("MSB")).toEqual(
      expect.arrayContaining(["MSB reports", "Check cashing report"]),
    );
    expect(items("Retail")).toContain("Store reports");
    expect(groups.map((g) => g.title)).not.toContain("Reports");
    // Store reports is flag-gated — an MSB-profile store (no
    // module_day_close) sees only the MSB center.
    const msbOnly = filterNavForRole("admin", ["reports.read"], []);
    expect(msbOnly.flatMap((g) => g.items.map((i) => i.label)))
      .not.toContain("Store reports");
  });

  it("Finance links the rules page so it is reachable from the nav", () => {
    const finance = filterNavForRole("admin", ["bank_sync.read"])
      .find((g) => g.title === "Finance");
    expect(finance!.items.map((i) => i.to))
      .toEqual(["/bank", "/bank-transactions", "/bank/rules"]);
  });

  it("Dashboard is its own direct-link entry above MSB and Retail", () => {
    const groups = filterNavForRole("admin", ["daily_book.read", "day_close.read"]);
    const titles = groups.map((g) => g.title);
    expect(titles.slice(0, 3)).toEqual(["Dashboard", "MSB", "Retail"]);
    const dash = groups.find((g) => g.title === "Dashboard");
    expect(dash!.to).toBe("/dashboard");
    const owner = filterNavForRole("owner", [])
      .find((g) => g.title === "Dashboard");
    expect(owner!.to).toBe("/owner/dashboard");
  });

  it("splits the store's work into MSB and Retail hubs", () => {
    const perms = [
      "transfers.read", "customers.read", "daily_book.read",
      "return_checks.read", "day_close.read", "lottery.read", "catalog.read",
    ];
    const groups = filterNavForRole("admin", perms);
    const msb = groups.find((g) => sectionSlug(g.title) === "msb");
    const retail = groups.find((g) => sectionSlug(g.title) === "retail");
    expect(msb!.items.map((i) => i.label)).toEqual(expect.arrayContaining([
      "MSB daily book", "Transfers", "Customers", "Returned checks",
    ]));
    expect(retail!.items.map((i) => i.label)).toEqual(expect.arrayContaining([
      "Store daily book", "Transactions", "Lottery", "Price book", "Purchases",
    ]));
    // The old groups are gone.
    expect(groups.map((g) => g.title)).not.toContain("Daily");
    expect(groups.map((g) => g.title)).not.toContain("Money services");
  });

  it("a gas station sees MSB only for its check work; a money-services store no Retail", () => {
    const perms = [
      "transfers.read", "customers.read", "daily_book.read", "reports.read",
      "return_checks.read", "day_close.read", "lottery.read", "catalog.read",
    ];
    // The business-type bundles (api/Modules/Billing/Services/feature_flags.py).
    const gasStation = filterNavForRole("admin", perms, [
      "module_lottery", "module_day_close", "module_check_cashing", "module_price_book",
    ]);
    const msb = gasStation.find((g) => g.title === "MSB")!;
    expect(msb.items.map((i) => i.label))
      .toEqual(["MSB daily book", "Returned checks", "MSB reports"]);
    expect(gasStation.map((g) => g.title)).toContain("Retail");
    const msbHybrid = filterNavForRole("admin", perms, [
      "module_money_services", "module_check_cashing",
    ]);
    expect(msbHybrid.map((g) => g.title)).not.toContain("Retail");
  });

  it("MSB links the check cashing app where the store has it", () => {
    const on = filterNavForRole("employee", ["check_cashing.read"], [CHECK_DESK_FLAG])
      .find((g) => g.title === "MSB");
    expect(on!.items.map((i) => i.to)).toContain(CHECK_HOME);
    const off = filterNavForRole("employee", ["check_cashing.read"], [])
      .flatMap((g) => g.items.map((i) => i.to));
    expect(off).not.toContain(CHECK_HOME);
    // No check rights → no link, even where the store has the app.
    const noRights = filterNavForRole("employee", ["daily_book.read"], [CHECK_DESK_FLAG])
      .flatMap((g) => g.items.map((i) => i.to));
    expect(noRights).not.toContain(CHECK_HOME);
  });

  it("Returned checks lives in MSB; TV display in Displays", () => {
    // TV display's route needs settings.read; nav visibility comes
    // from the route table, so the permission has to be held here.
    const groups = filterNavForRole(
      "admin", ["return_checks.read", "settings.read"], ["module_check_cashing"],
    );
    const ms = groups.find((g) => g.title === "MSB");
    expect(ms!.items.map((i) => i.label)).toContain("Returned checks");
    const displays = groups.find((g) => g.title === "Displays");
    expect(displays!.items.map((i) => i.label)).toEqual(["TV display"]);
  });

  it("superadmin nav carries no store-level modules", () => {
    const labels = filterNavForRole("superadmin", [])
      .flatMap((g) => g.items.map((i) => i.label));
    for (const storeOnly of [
      "MSB daily book", "Store daily book", "Transactions", "Lottery",
      "Price book", "Purchases", "Check cashing", "MSB reports",
      "Store reports", "Departments",
    ]) {
      expect(labels).not.toContain(storeOnly);
    }
  });

  it("Departments is for store people, never the superadmin", () => {
    // Owner, 2026-11-19: superadmin passes every permission check but
    // has no store, so a store page never belongs in their sidebar.
    const account = (role: string) => filterNavForRole(role, ["day_close.read"])
      .find((g) => g.title === "Account")!.items.map((i) => i.label);
    expect(account("superadmin")).not.toContain("Departments");
    expect(account("admin")).toContain("Departments");
    expect(account("employee")).toContain("Departments");
  });

  it("Purchases follows the price-book flag, admin only", () => {
    const on = filterNavForRole(
      "admin", ["catalog.read"], ["module_price_book"],
    ).flatMap((g) => g.items.map((i) => i.label));
    expect(on).toContain("Purchases");
    const off = filterNavForRole(
      "admin", ["catalog.read"], [],
    ).flatMap((g) => g.items.map((i) => i.label));
    expect(off).not.toContain("Purchases");
    const employee = filterNavForRole(
      "employee", ["catalog.read"], ["module_price_book"],
    ).flatMap((g) => g.items.map((i) => i.label));
    expect(employee).not.toContain("Purchases");
    expect(employee).toContain("Price book");
  });
});

describe("module-flag gating (business-type bundles)", () => {
  const perms = [
    "transfers.read", "customers.read", "batches.read",
    "daily_book.read", "return_checks.read",
  ];

  it("hides money-services items when the module flag is off", () => {
    // module_check_cashing is bundled ON for every business type,
    // so a realistic features list carries it even when money
    // services is off (P1-11).
    const groups = filterNavForRole(
      "admin", perms, ["module_check_cashing"],
    );
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain("Transfers");
    expect(labels).not.toContain("Customers");
    expect(labels).not.toContain("ACH batches");
    expect(labels).toContain("Returned checks");
    expect(labels).toContain("MSB daily book");
  });

  it("hides Returned checks when check cashing is switched off", () => {
    const groups = filterNavForRole("admin", perms, []);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).not.toContain("Returned checks");
    expect(labels).toContain("MSB daily book");
  });

  it("shows them when module_money_services is on", () => {
    const groups = filterNavForRole(
      "admin", perms, ["module_money_services"],
    );
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Transfers");
    expect(labels).toContain("ACH batches");
  });

  it("gates Price book on module_price_book + catalog.read", () => {
    const withFlag = filterNavForRole(
      "admin", [...perms, "catalog.read"], ["module_price_book"],
    );
    expect(withFlag.flatMap((g) => g.items.map((i) => i.label)))
      .toContain("Price book");
    // Flag off (msb_hybrid bundle) → hidden.
    const withoutFlag = filterNavForRole(
      "admin", [...perms, "catalog.read"], [],
    );
    expect(withoutFlag.flatMap((g) => g.items.map((i) => i.label)))
      .not.toContain("Price book");
    // Flag on but no catalog permission → hidden.
    const withoutPerm = filterNavForRole(
      "admin", perms, ["module_price_book"],
    );
    expect(withoutPerm.flatMap((g) => g.items.map((i) => i.label)))
      .not.toContain("Price book");
  });

  it("shows everything while features are still loading (undefined)", () => {
    const groups = filterNavForRole("admin", perms, undefined);
    const labels = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Transfers");
  });

  it("superadmin nav is identical with or without module flags", () => {
    const withFlags = filterNavForRole("superadmin", [], []);
    const without = filterNavForRole("superadmin", [], undefined);
    expect(withFlags.map((g) => g.items.map((i) => i.label)))
      .toEqual(without.map((g) => g.items.map((i) => i.label)));
  });
});

describe("navTrail", () => {
  const admin = filterNavForRole("admin", TEST_ADMIN.permissions);

  it("returns the section and item for a sidebar route", () => {
    expect(navTrail("/employees", admin)).toEqual([
      { label: "Team", to: "/hub/team" },
      { label: "Employees", to: "/employees" },
    ]);
  });

  it("covers the pages under a sidebar route", () => {
    expect(navTrail("/employees/4/edit", admin).map((c) => c.label))
      .toEqual(["Team", "Employees"]);
  });

  it("returns a direct-link section on its own", () => {
    expect(navTrail("/dashboard", admin)).toEqual([
      { label: "Dashboard", to: "/dashboard" },
    ]);
    expect(navTrail("/superadmin/dashboard", filterNavForRole("superadmin", [])))
      .toEqual([{ label: "Dashboard", to: "/superadmin/dashboard" }]);
  });

  it("returns nothing for a route the sidebar does not cover", () => {
    expect(navTrail("/monthly", admin)).toEqual([]);
  });
});

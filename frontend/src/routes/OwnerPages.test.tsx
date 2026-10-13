import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OwnerActivity from "./OwnerActivity";
import OwnerDashboard from "./OwnerDashboard";
import OwnerPLRollup from "./OwnerPLRollup";
import OwnerReports from "./OwnerReports";
import OwnerSettings from "./OwnerSettings";
import OwnerStoreDetail from "./OwnerStoreDetail";
import OwnerUsers from "./OwnerUsers";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The owner umbrella's read pages. Each one rolls several stores'
// numbers up, so pin that the server's figures land on the page, that
// a failed load offers a retry (never a blank page), that a store
// login sees no owner data, and the one write here (disconnect a
// store) on success and refusal.

// jsdom has no canvas; the charts are not what these tests read.
vi.mock("react-chartjs-2", () => ({
  Line: () => <div data-testid="chart" />,
  Bar: () => <div data-testid="chart" />,
}));

const LOCATIONS = {
  rows: [{ store_id: 1, store_name: "Uno", store_slug: "uno", transfer_count: 12,
    volume: 0, over_short: 0, report_count: 0, companies: [] }],
  total: 1, matched: 1,
};

beforeEach(() => { signInAs({ role: "owner", store_id: null, permissions: [] }); });
afterEach(() => { vi.unstubAllGlobals(); });

function failThenServe(body: unknown) {
  const state = { fail: true };
  const handler: MockHandler = () => (state.fail
    ? { status: 500, body: { detail: "Database unavailable." } }
    : { body });
  return { state, handler };
}

describe("OwnerDashboard", () => {
  const DASH = {
    period: "month", prev_label: "Sep 2026", period_start: "", period_end: "",
    store_count: 2, agg_transfers: 1234, agg_volume: 56000, agg_over_short: -12.5,
    agg_transfers_delta: 10, agg_volume_delta: 100, agg_over_short_delta: -1,
    stores: [{ id: 1, name: "Uno", slug: "uno", count: 3, volume: 900, over_short: 2 }],
    series_labels: ["Oct 1"], series_volume: [900], series_count: [3],
    company_breakdown: [{ company: "Intermex", count: 3, volume: 900 }],
  };

  it("renders the rolled-up KPIs, stores and companies", async () => {
    mockFetch({ "GET /api/v2/owner/dashboard": { body: DASH } });
    renderRoute(<OwnerDashboard />);
    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("-$13")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Uno/ })).toBeInTheDocument();
    expect(screen.getByText("Intermex")).toBeInTheDocument();
    expect(screen.getByText("Company breakdown (Sep 2026)")).toBeInTheDocument();
  });

  it("reloads for the period tab picked", async () => {
    const calls = mockFetch({ "GET /api/v2/owner/dashboard": { body: DASH } });
    renderRoute(<OwnerDashboard />);
    await screen.findByText("1,234");
    await userEvent.click(screen.getByRole("tab", { name: "This Year" }));
    await vi.waitFor(() => expect(
      calls.some((c) => c.path === "/api/v2/owner/dashboard?period=year"),
    ).toBe(true));
  });

  it("offers a retry when the dashboard fails", async () => {
    const { state, handler } = failThenServe(DASH);
    mockFetch({ "GET /api/v2/owner/dashboard": handler });
    renderRoute(<OwnerDashboard />);
    expect(await screen.findByText("Couldn't load dashboard — Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1,234")).toBeInTheDocument();
  });
});

describe("OwnerPLRollup", () => {
  const PL = {
    year: 2026, month: 9, year_choices: [2025, 2026],
    rows: [
      { store_id: 1, store_name: "Uno", store_slug: "uno", has_pl: true,
        revenue: 5000, purchases: 1000, expenses: 1500, over_short: -20, net: 2480 },
      { store_id: 2, store_name: "Dos", store_slug: "dos", has_pl: false,
        revenue: 0, purchases: 0, expenses: 0, over_short: 0, net: 0 },
    ],
    totals: { revenue: 5000, purchases: 1000, expenses: 1500, over_short: -20, net: 2480 },
  };

  it("renders each store's P&L and the totals for the URL's month", async () => {
    const calls = mockFetch({ "GET /api/v2/owner/pl-rollup": { body: PL } });
    renderRoute(<OwnerPLRollup />, { path: "/owner/pl-rollup", at: "/owner/pl-rollup?year=2026&month=9" });
    expect(await screen.findByText("September 2026 · 2 stores")).toBeInTheDocument();
    expect(screen.getByText("no P&L on file")).toBeInTheDocument();
    expect(screen.getAllByText("+$2,480.00")).toHaveLength(2);
    expect(callsTo(calls, "GET /api/v2/owner/pl-rollup")[0].path)
      .toBe("/api/v2/owner/pl-rollup?year=2026&month=9");
  });

  it("shows the empty state with no stores", async () => {
    mockFetch({ "GET /api/v2/owner/pl-rollup": { body: { ...PL, rows: [] } } });
    renderRoute(<OwnerPLRollup />, { path: "/owner/pl-rollup" });
    expect(await screen.findByText("No stores connected")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(PL);
    mockFetch({ "GET /api/v2/owner/pl-rollup": handler });
    renderRoute(<OwnerPLRollup />, { path: "/owner/pl-rollup" });
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("no P&L on file")).toBeInTheDocument();
  });

  it("shows a store admin nothing and fetches nothing", async () => {
    signInAs({ role: "admin" });
    const calls = mockFetch({});
    renderRoute(<OwnerPLRollup />, { path: "/owner/pl-rollup" });
    expect(screen.getByText("Sign in as an owner to view per-store P&L.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("OwnerStoreDetail", () => {
  const DETAIL = {
    store: { id: 1, name: "Uno", slug: "uno", plan: "pro" },
    period: "month", prev_label: "", period_start: "", period_end: "",
    company_rows: [{ company: "Maxi", count: 2, volume: 400, fees: 10, tax: 2 }],
    period_count: 2, period_volume: 400, period_fees: 10, period_tax: 2,
    period_over_short: 5, prev_count: 1, prev_volume: 100,
    daily_labels: ["2026-10-01"], over_short_data: [5], receipts_data: [400],
    recent_transfers: [{ id: 9, send_date: "2026-10-02", sender_name: "Ana",
      recipient_name: "Luis", company: "Maxi", send_amount: 400, country: "MX", status: "sent" }],
  };
  const at = { path: "/owner/store/:storeId", at: "/owner/store/1" };

  it("renders the store's KPIs, companies and recent transfers", async () => {
    mockFetch({ "GET /api/v2/owner/store/1": { body: DETAIL } });
    renderRoute(<OwnerStoreDetail />, at);
    expect(await screen.findByRole("heading", { name: "Uno" })).toBeInTheDocument();
    expect(screen.getByText("Luis")).toBeInTheDocument();
    expect(screen.getAllByText("Maxi").length).toBeGreaterThan(0);
    expect(screen.getByText("+$5.00")).toBeInTheDocument();
  });

  it("disconnects the store after confirming and goes back to locations", async () => {
    const calls = mockFetch({
      "GET /api/v2/owner/store/1": { body: DETAIL },
      "POST /api/v2/owner/unlink/1": { body: { ok: true } },
    });
    renderRoute(<OwnerStoreDetail />, at);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect store" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Disconnect "Uno"/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Navigated to /owner/locations")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/owner/unlink/1")).toHaveLength(1);
  });

  it("shows a refused disconnect and stays", async () => {
    mockFetch({
      "GET /api/v2/owner/store/1": { body: DETAIL },
      "POST /api/v2/owner/unlink/1": { status: 403, body: { detail: "Not linked to you." } },
    });
    renderRoute(<OwnerStoreDetail />, at);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect store" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not linked to you.")).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).not.toBeInTheDocument();
  });

  it("shows the server's error for a store outside the umbrella", async () => {
    mockFetch({ "GET /api/v2/owner/store/1": { status: 403, body: { detail: "Not your store." } } });
    renderRoute(<OwnerStoreDetail />, at);
    expect(await screen.findByText("Couldn't load store — Not your store.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("OwnerUsers", () => {
  const USERS = {
    rows: [{ id: 5, username: "ana", full_name: "Ana", role: "employee",
      is_active: false, store_id: 1, store_name: "Uno" }],
    total: 1, page: 1, total_pages: 1,
  };

  it("lists users across stores", async () => {
    mockFetch({ "GET /api/v2/owner/users": { body: USERS } });
    renderRoute(<OwnerUsers />);
    expect(await screen.findByText("ana")).toBeInTheDocument();
    expect(screen.getByText("Uno")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("searches as you type", async () => {
    const calls = mockFetch({ "GET /api/v2/owner/users": { body: USERS } });
    renderRoute(<OwnerUsers />);
    await screen.findByText("ana");
    await userEvent.type(screen.getByPlaceholderText(/Search by name/), "an");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("q") === "an"),
    ).toBe(true), { timeout: 2000 });
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/owner/users": { body: { ...USERS, rows: [] } } });
    renderRoute(<OwnerUsers />);
    expect(await screen.findByText("No users found")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(USERS);
    mockFetch({ "GET /api/v2/owner/users": handler });
    renderRoute(<OwnerUsers />);
    expect(await screen.findByText("Could not load users.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("ana")).toBeInTheDocument();
  });
});

describe("OwnerActivity", () => {
  const ACT = {
    rows: [{ type: "transfer", store_id: 1, store_name: "Uno", user_name: "Ana",
      user_role: "employee", action: "transfer.create", target_type: "transfer",
      target_label: "#9", summary: "Sent $400 to Luis", created_at: "2026-10-09T15:00:00" }],
    total: 1, page: 1, total_pages: 1,
  };

  it("lists events across stores", async () => {
    mockFetch({ "GET /api/v2/owner/activity": { body: ACT } });
    renderRoute(<OwnerActivity />);
    expect(await screen.findByText("Sent $400 to Luis")).toBeInTheDocument();
    expect(screen.getByText("transfer.create")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/owner/activity": { body: { ...ACT, rows: [] } } });
    renderRoute(<OwnerActivity />);
    expect(await screen.findByText("No activity")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(ACT);
    mockFetch({ "GET /api/v2/owner/activity": handler });
    renderRoute(<OwnerActivity />);
    expect(await screen.findByText("Could not load activity.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Sent $400 to Luis")).toBeInTheDocument();
  });

  it("fetches nothing for a store login", async () => {
    signInAs({ role: "admin" });
    const calls = mockFetch({});
    renderRoute(<OwnerActivity />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });
});

describe("OwnerSettings", () => {
  const PROFILE = { username: "olga", full_name: "Olga", email: "o@x.test", phone: "" };

  it("shows the profile, linked stores and quick links", async () => {
    mockFetch({
      "GET /api/v2/auth/profile": { body: PROFILE },
      "GET /api/v2/owner/locations": { body: LOCATIONS },
    });
    renderRoute(<OwnerSettings />);
    expect(await screen.findByText("12 transfers")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Bulk permissions/ })).toBeInTheDocument();
  });

  it("offers a connect code when no store is linked", async () => {
    mockFetch({
      "GET /api/v2/auth/profile": { body: PROFILE },
      "GET /api/v2/owner/locations": { body: { rows: [], total: 0, matched: 0 } },
    });
    renderRoute(<OwnerSettings />);
    expect(await screen.findByRole("link", { name: "Generate a connect code" })).toBeInTheDocument();
  });

  it("offers a retry when the stores fail", async () => {
    mockFetch({
      "GET /api/v2/auth/profile": { body: PROFILE },
      "GET /api/v2/owner/locations": { status: 500, body: {} },
    });
    renderRoute(<OwnerSettings />);
    expect(await screen.findByText("Could not load your stores.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("OwnerReports", () => {
  const LIST = {
    categories: [{ key: "msb", label: "Money services", icon: "", reports: [
      { key: "fees", label: "Fees vs Tax", description: "Fee revenue against tax",
        url: "/owner/reports/fees-vs-tax", status: "ready" },
    ] }],
  };

  it("lists the owner's reports", async () => {
    mockFetch({ "GET /api/v2/owner/reports": { body: LIST } });
    renderRoute(<OwnerReports />);
    expect(await screen.findByText("Fees vs Tax")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View" })).toBeInTheDocument();
  });

  it("says owner scope is required on a 403, with no pointless retry", async () => {
    mockFetch({ "GET /api/v2/owner/reports": { status: 403, body: { detail: "Owner only" } } });
    renderRoute(<OwnerReports />);
    expect(await screen.findByText("Owner scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers a retry on any other failure", async () => {
    const { state, handler } = failThenServe(LIST);
    mockFetch({ "GET /api/v2/owner/reports": handler });
    renderRoute(<OwnerReports />);
    expect(await screen.findByText(/Couldn't load the report list/)).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fees vs Tax")).toBeInTheDocument();
  });
});

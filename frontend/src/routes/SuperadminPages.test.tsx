import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Dashboard from "./Dashboard";
import SuperadminAuditLog from "./SuperadminAuditLog";
import SuperadminBilling from "./SuperadminBilling";
import SuperadminControls from "./SuperadminControls";
import SuperadminDashboard from "./SuperadminDashboard";
import SuperadminEmailLog from "./SuperadminEmailLog";
import SuperadminHealth from "./SuperadminHealth";
import SuperadminReports from "./SuperadminReports";
import SuperadminStoreForm from "./SuperadminStoreForm";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The platform pages. Each reads platform-wide data, so pin that the
// server's figures render, that a failed load offers a retry, that a
// store login fetches nothing, and the writes here (pause a store's
// retention clock, create / edit a store) on success and refusal.

vi.mock("react-chartjs-2", () => ({
  Line: () => <div data-testid="chart" />,
  Bar: () => <div data-testid="chart" />,
  Doughnut: () => <div data-testid="chart" />,
}));

beforeEach(() => { signInAs({ role: "superadmin", store_id: null, permissions: [] }); });
afterEach(() => { vi.unstubAllGlobals(); });

function failThenServe(body: unknown) {
  const state = { fail: true };
  const handler: MockHandler = () => (state.fail
    ? { status: 500, body: { detail: "Database unavailable." } }
    : { body });
  return { state, handler };
}

describe("SuperadminDashboard", () => {
  const DASH = {
    total_stores: 1500, active_count: 1200, trial_count: 100, paid_count: 1100,
    inactive_count: 300, estimated_mrr: 45000, new_stores_30d: 12, new_stores_delta: 2,
    churn_30d: 3, churn_delta: -1, basic_count: 600, pro_count: 500,
    basic_monthly: 500, basic_yearly: 100, pro_monthly: 400, pro_yearly: 100,
    basic_monthly_mrr: 15000, basic_yearly_mrr: 2500, pro_monthly_mrr: 24000, pro_yearly_mrr: 3500,
    signup_labels: ["2026-10-01"], signup_direct: [1], signup_referral: [0],
    plan_dist: [], volume_by_company: [{ company: "Intermex", count: 5, total: 900 }],
    total_volume_30d: 900, total_transfers_30d: 5, top_referrers: [],
    direct_signups: 1, referral_signups: 0,
    activity: [{ when: "2026-10-09T15:00:00", kind: "signup", store_name: "Cambio Nuevo",
      detail: "Signed up", plan: "trial" }],
    mrr_trend: { labels: ["Oct"], values: [45000] },
  };

  it("renders platform KPIs and recent activity", async () => {
    mockFetch({ "GET /api/v2/superadmin/dashboard": { body: DASH } });
    renderRoute(<SuperadminDashboard />);
    expect(await screen.findByText("1,500")).toBeInTheDocument();
    expect(screen.getByText("Cambio Nuevo")).toBeInTheDocument();
  });

  it("shows the kit empty state when there is no recent activity", async () => {
    mockFetch({ "GET /api/v2/superadmin/dashboard": { body: { ...DASH, activity: [] } } });
    renderRoute(<SuperadminDashboard />);
    expect(await screen.findByText("No recent activity", { selector: "div" })).toBeInTheDocument();
    expect(screen.getByText("New signups and cancellations show here.")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(DASH);
    mockFetch({ "GET /api/v2/superadmin/dashboard": handler });
    renderRoute(<SuperadminDashboard />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1,500")).toBeInTheDocument();
  });

  it("fetches nothing for a store admin", async () => {
    signInAs({ role: "admin" });
    const calls = mockFetch({});
    renderRoute(<SuperadminDashboard />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });
});

describe("SuperadminAuditLog", () => {
  const LOG = {
    rows: [{ id: 1, admin_id: 1, admin_name: "root", action: "store.extend_trial",
      target_type: "store", target_id: "7", details: "+14 days", created_at: "2026-10-09T15:00:00" }],
    total: 1, page: 1, total_pages: 1,
  };

  it("lists entries and filters by action as you type", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/audit-log": { body: LOG } });
    renderRoute(<SuperadminAuditLog />);
    expect(await screen.findByText("store.extend_trial")).toBeInTheDocument();
    expect(screen.getByText("+14 days")).toBeInTheDocument();
    const box = screen.getByPlaceholderText("Filter by action…");
    await userEvent.type(box, "s");
    await new Promise((r) => setTimeout(r, 450));
    // One character is under the 2-char minimum: no filtered request.
    expect(calls.some((c) => c.url.searchParams.has("action"))).toBe(false);
    await userEvent.type(box, "t");
    // No Enter, no blur: the debounce applies it.
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("action") === "st"),
    ).toBe(true), { timeout: 2000 });
    expect(box).toHaveFocus();
  });

  it("restores the action filter from the URL", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/audit-log": { body: LOG } });
    renderRoute(<SuperadminAuditLog />, { at: "/?action=trial" });
    expect(await screen.findByText("store.extend_trial")).toBeInTheDocument();
    expect(calls[0].url.searchParams.get("action")).toBe("trial");
    expect(screen.getByPlaceholderText("Filter by action…")).toHaveValue("trial");
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/superadmin/audit-log": { body: { ...LOG, rows: [], total: 0 } } });
    renderRoute(<SuperadminAuditLog />);
    expect(await screen.findByText("No audit entries match.")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(LOG);
    mockFetch({ "GET /api/v2/superadmin/audit-log": handler });
    renderRoute(<SuperadminAuditLog />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("store.extend_trial")).toBeInTheDocument();
  });

  it("refuses a store admin", () => {
    signInAs({ role: "admin" });
    mockFetch({});
    renderRoute(<SuperadminAuditLog />);
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
  });
});

describe("SuperadminBilling", () => {
  const BILLING = {
    expiring_soon: [{ store_id: 1, name: "Uno", slug: "uno", plan: "trial",
      email: "uno@x.test", trial_ends_at: "2026-10-20" }],
    in_grace: [],
    retention_queue: [{ store_id: 2, name: "Dos", slug: "dos", plan: "inactive",
      email: "", days_left: 40 }],
    recent_cancels: [],
    webhook_stats: { ok: 10, error: 1 },
  };

  it("renders each queue and the empty ones", async () => {
    mockFetch({ "GET /api/v2/superadmin/billing-overview": { body: BILLING } });
    renderRoute(<SuperadminBilling />);
    expect(await screen.findByText("uno · uno@x.test")).toBeInTheDocument();
    expect(screen.getByText("40 days left")).toBeInTheDocument();
    expect(screen.getByText("No stores in grace period.")).toBeInTheDocument();
    expect(screen.getByText("No cancellations in the last 30 days.")).toBeInTheDocument();
  });

  it("pauses a store's retention clock after confirming", async () => {
    const calls = mockFetch({
      "GET /api/v2/superadmin/billing-overview": { body: BILLING },
      "POST /api/v2/superadmin/stores/2/clear-retention": { body: { ok: true } },
    });
    renderRoute(<SuperadminBilling />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause clock" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Clear the retention timer for "Dos"/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Pause clock" }));
    expect(await screen.findByText("Retention timer cleared for Dos.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/superadmin/stores/2/clear-retention")).toHaveLength(1);
  });

  it("shows a refused pause", async () => {
    mockFetch({
      "GET /api/v2/superadmin/billing-overview": { body: BILLING },
      "POST /api/v2/superadmin/stores/2/clear-retention": { status: 403, body: { detail: "Superadmin only." } },
    });
    renderRoute(<SuperadminBilling />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause clock" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Pause clock" }));
    expect(await screen.findByText("Superadmin only.")).toBeInTheDocument();
  });

  it("previews the purge and shows a failed preview", async () => {
    let fail = false;
    mockFetch({
      "GET /api/v2/superadmin/billing-overview": { body: BILLING },
      "GET /api/v2/superadmin/retention-dry-run": () => (fail
        ? { status: 500, body: { detail: "Purge preview failed." } }
        : { body: { now: "", store_count: 1, total_child_rows: 1234, stores: [{
            store_id: 2, name: "Dos", slug: "dos", canceled_at: "", data_retention_until: "",
            row_count: 1234, row_counts: { transfers: 1234, batches: 0 } }] } }),
    });
    renderRoute(<SuperadminBilling />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText("dos · 1,234 rows (transfers: 1234)")).toBeInTheDocument();
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(await screen.findByText("Purge preview failed.")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    mockFetch({ "GET /api/v2/superadmin/billing-overview": { status: 500, body: {} } });
    renderRoute(<SuperadminBilling />);
    expect(await screen.findByText("Request failed (500)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("SuperadminControls", () => {
  // The superadmin answer of /dashboard/summary: exactly the ten tiles.
  const SUMMARY = {
    role: "superadmin", total_stores: 42, active_stores: 37, trial_stores: 5,
    paid_stores: 30, inactive_stores: 2, mrr_total: 1234, arr_total: 14808,
    new_stores_30d: 6, cancellations_30d: 1, retention_queue: 3,
  };

  function tile(label: string) {
    return screen.getByText(label).parentElement as HTMLElement;
  }

  it("renders every platform figure and the hubs", async () => {
    mockFetch({ "GET /api/v2/dashboard/summary": { body: SUMMARY } });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(within(tile("Active")).getByText("37")).toBeInTheDocument();
    expect(within(tile("Trial")).getByText("5")).toBeInTheDocument();
    expect(within(tile("Paid")).getByText("30")).toBeInTheDocument();
    expect(within(tile("Inactive")).getByText("2")).toBeInTheDocument();
    expect(within(tile("Retention queue")).getByText("3")).toBeInTheDocument();
    expect(within(tile("MRR")).getByText("$1,234")).toBeInTheDocument();
    expect(within(tile("ARR")).getByText("$14,808")).toBeInTheDocument();
    expect(within(tile("New (30d)")).getByText("6")).toBeInTheDocument();
    expect(within(tile("Cancellations (30d)")).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Audit log/ })).toBeInTheDocument();
  });

  it("shows zero figures as 0, not a dash", async () => {
    mockFetch({
      "GET /api/v2/dashboard/summary": {
        body: { ...SUMMARY, mrr_total: 0, arr_total: 0, retention_queue: 0 },
      },
    });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(within(tile("MRR")).getByText("$0")).toBeInTheDocument();
    expect(within(tile("Retention queue")).getByText("0")).toBeInTheDocument();
  });

  it("shows no platform figures for a store-shaped answer", async () => {
    const calls = mockFetch({
      "GET /api/v2/dashboard/summary": { body: { role: "admin" } },
    });
    renderRoute(<SuperadminControls />);
    await vi.waitFor(() => expect(callsTo(calls, "GET /api/v2/dashboard/summary")).toHaveLength(1));
    expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Audit log/ })).toBeInTheDocument();
  });

  it("offers a retry when the metrics fail, and recovers", async () => {
    const { state, handler } = failThenServe(SUMMARY);
    mockFetch({ "GET /api/v2/dashboard/summary": handler });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("Couldn't load metrics for the overview.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("42")).toBeInTheDocument();
  });
});

describe("Dashboard as superadmin", () => {
  it("sends the superadmin to the platform dashboard", () => {
    mockFetch({ "GET /api/v2/dashboard/summary": { body: { role: "superadmin" } } });
    renderRoute(<Dashboard />);
    expect(screen.getByText("Navigated to /superadmin/dashboard")).toBeInTheDocument();
  });
});

describe("SuperadminEmailLog", () => {
  const LOG = {
    rows: [{ id: 1, to_addr: "ana@x.test", event_type: "email.bounced", bounce_type: "hard",
      message_id: "msg_0123456789abcdefXYZ", created_at: "2026-10-09T15:00:00" }],
    total: 1, page: 1, total_pages: 1,
    suppressed: [{ user_id: 5, username: "ana", email: "ana@x.test", bounced_at: "2026-10-09" }],
  };

  it("lists events and suppressed addresses, and filters by event type", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/email-log": { body: LOG } });
    renderRoute(<SuperadminEmailLog />);
    expect(await screen.findByRole("cell", { name: "Bounced" })).toBeInTheDocument();
    expect(screen.getByText("Suppressed addresses (1)")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox"), "email.bounced");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("event_type") === "email.bounced"),
    ).toBe(true));
  });

  it("searches as you type, debounced, with a 2-char minimum", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/email-log": { body: LOG } });
    renderRoute(<SuperadminEmailLog />);
    await screen.findByRole("cell", { name: "Bounced" });
    const box = screen.getByPlaceholderText("Search email address…");
    await userEvent.type(box, "a");
    await new Promise((r) => setTimeout(r, 450));
    expect(calls.some((c) => c.url.searchParams.has("q"))).toBe(false);
    await userEvent.type(box, "na");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("q") === "ana"),
    ).toBe(true), { timeout: 2000 });
    // The keystroke in between never became its own request.
    expect(calls.some((c) => c.url.searchParams.get("q") === "an")).toBe(false);
  });

  it("restores the search and event filter from the URL", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/email-log": { body: LOG } });
    renderRoute(<SuperadminEmailLog />, { at: "/?q=ana&event_type=email.bounced" });
    await screen.findByRole("cell", { name: "Bounced" });
    expect(calls[0].url.searchParams.get("q")).toBe("ana");
    expect(calls[0].url.searchParams.get("event_type")).toBe("email.bounced");
    expect(screen.getByPlaceholderText("Search email address…")).toHaveValue("ana");
    expect(screen.getByRole("combobox")).toHaveValue("email.bounced");
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/superadmin/email-log": { body: { ...LOG, rows: [], suppressed: [] } } });
    renderRoute(<SuperadminEmailLog />);
    expect(await screen.findByText("No email events match the filters.")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(LOG);
    mockFetch({ "GET /api/v2/superadmin/email-log": handler });
    renderRoute(<SuperadminEmailLog />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("cell", { name: "Bounced" })).toBeInTheDocument();
  });
});

describe("SuperadminHealth", () => {
  const HEALTH = {
    db: { ok: true, error: "", total_users: 10, total_stores: 4, total_transfers: 99 },
    stripe: { ok: false, error: "No key", env: { STRIPE_SECRET_KEY: false } },
    email: { configured: true, status: "ok" },
    queue: { enabled: false, redis_configured: false },
    rate_limiting: { enabled: true },
    env: { python_version: "3.12", platform: "linux", server_time: "2026-10-13T12:00:00.000",
      database_url_set: true, secret_key_set: true, sentry_dsn_set: false, webauthn_rp_id: "dinerobook.com" },
  };

  it("renders each subsystem's status", async () => {
    mockFetch({ "GET /api/v2/superadmin/system-health": { body: HEALTH } });
    renderRoute(<SuperadminHealth />);
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Sync mode")).toBeInTheDocument();
    expect(screen.getByText("dinerobook.com")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(HEALTH);
    mockFetch({ "GET /api/v2/superadmin/system-health": handler });
    renderRoute(<SuperadminHealth />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });
});

describe("SuperadminReports", () => {
  const LIST = {
    categories: [{ key: "platform", label: "Platform", icon: "", reports: [
      { key: "mrr", label: "MRR by plan", description: "Recurring revenue", url: "/superadmin/reports/mrr", status: "ready" },
    ] }],
  };

  it("lists the platform reports", async () => {
    mockFetch({ "GET /api/v2/superadmin/reports": { body: LIST } });
    renderRoute(<SuperadminReports />);
    expect(await screen.findByText("MRR by plan")).toBeInTheDocument();
  });

  it("says scope is required on a 403, with no retry", async () => {
    mockFetch({ "GET /api/v2/superadmin/reports": { status: 403, body: { detail: "no" } } });
    renderRoute(<SuperadminReports />);
    expect(await screen.findByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("offers a retry on any other failure", async () => {
    const { state, handler } = failThenServe(LIST);
    mockFetch({ "GET /api/v2/superadmin/reports": handler });
    renderRoute(<SuperadminReports />);
    expect(await screen.findByText(/Couldn't load the report list/)).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("MRR by plan")).toBeInTheDocument();
  });
});

describe("SuperadminStoreForm", () => {
  const STORE = {
    store: { id: 7, name: "Uno", slug: "uno", email: "uno@x.test", phone: "",
      address: "1 Main", plan: "basic", business_type: "cstore", federal_tax_rate: 0.01 },
  };

  async function fillCreate() {
    await userEvent.type(screen.getByLabelText(/Business name/), "Cambio Tres");
    await userEvent.type(screen.getByLabelText(/URL slug/), "cambio-tres");
    await userEvent.type(screen.getByLabelText(/Admin password/), "s3cret-pass!");
  }

  it("refuses a store admin", () => {
    signInAs({ role: "admin" });
    mockFetch({});
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create store" })).not.toBeInTheDocument();
  });

  it("creates a store with its first login, toasts and returns to the list", async () => {
    const calls = mockFetch({ "POST /api/v2/superadmin/stores": { body: STORE } });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    expect(screen.getByRole("button", { name: "Create store" })).toBeDisabled();
    await fillCreate();
    await userEvent.click(screen.getByRole("button", { name: "Create store" }));
    expect(await screen.findByText("Navigated to /superadmin/stores")).toBeInTheDocument();
    expect(screen.getByText("Store Cambio Tres created.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/superadmin/stores")[0].body).toMatchObject({
      name: "Cambio Tres", slug: "cambio-tres", plan: "trial",
      admin_username: "admin", admin_password: "s3cret-pass!", initial_role: "admin",
    });
  });

  it("puts a field-level 409 next to the field", async () => {
    mockFetch({
      "POST /api/v2/superadmin/stores": {
        status: 409, body: { detail: { field: "slug", message: "That slug is taken." } },
      },
    });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    await fillCreate();
    await userEvent.click(screen.getByRole("button", { name: "Create store" }));
    expect(await screen.findByText("That slug is taken.")).toBeInTheDocument();
    expect(screen.queryByText(/Navigated to/)).not.toBeInTheDocument();
  });

  it("maps a Pydantic 422 to its field", async () => {
    mockFetch({
      "POST /api/v2/superadmin/stores": {
        status: 422, body: { detail: [{ loc: ["body", "admin_password"], msg: "Too short" }] },
      },
    });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    await fillCreate();
    await userEvent.click(screen.getByRole("button", { name: "Create store" }));
    expect(await screen.findByText("Too short")).toBeInTheDocument();
  });

  it("catches a bad email before calling the server", async () => {
    const calls = mockFetch({});
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    await fillCreate();
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    // Submit the form directly: the browser's own type=email check
    // would stop a click first; the shared validator is the layer
    // that names the field.
    fireEvent.submit(screen.getByRole("button", { name: "Create store" }).closest("form")!);
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/superadmin/stores")).toHaveLength(0);
  });

  it("edits a store: hydrates, saves the changed fields, and toasts", async () => {
    const calls = mockFetch({
      "GET /api/v2/superadmin/stores/7": { body: STORE },
      "PATCH /api/v2/superadmin/stores/7": { body: STORE },
    });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/:id/edit", at: "/superadmin/stores/7/edit" });
    const name = await screen.findByLabelText(/Business name/);
    expect(name).toHaveValue("Uno");
    expect(screen.queryByLabelText(/Admin password/)).not.toBeInTheDocument();
    await userEvent.clear(name);
    await userEvent.type(name, "Uno Renamed");
    await userEvent.selectOptions(screen.getByLabelText("Plan"), "pro");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Store updated.")).toBeInTheDocument();
    expect(callsTo(calls, "PATCH /api/v2/superadmin/stores/7")[0].body).toMatchObject({
      name: "Uno Renamed", slug: "uno", plan: "pro", federal_tax_rate: 0.01,
    });
  });

  it("shows a refused edit", async () => {
    mockFetch({
      "GET /api/v2/superadmin/stores/7": { body: STORE },
      "PATCH /api/v2/superadmin/stores/7": { status: 403, body: { detail: "Superadmin only." } },
    });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/:id/edit", at: "/superadmin/stores/7/edit" });
    await screen.findByDisplayValue("Uno");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Superadmin only.")).toBeInTheDocument();
  });

  it("offers a retry when the store fails to load", async () => {
    const { state, handler } = failThenServe(STORE);
    mockFetch({ "GET /api/v2/superadmin/stores/7": handler });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/:id/edit", at: "/superadmin/stores/7/edit" });
    expect(await screen.findByText("Couldn't load the store. Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByDisplayValue("Uno")).toBeInTheDocument();
  });
});

describe("platform pages in Spanish", () => {
  beforeEach(() => { setLanguage("es"); });

  it("reads the audit log in Spanish", async () => {
    mockFetch({ "GET /api/v2/superadmin/audit-log": { body: {
      rows: [{ id: 1, admin_id: 1, admin_name: "root", action: "store.extend_trial",
        target_type: "store", target_id: "7", details: "+14 days", created_at: "2026-10-09T15:00:00" }],
      total: 1, page: 1, total_pages: 1,
    } } });
    renderRoute(<SuperadminAuditLog />);
    expect(await screen.findByText("1 registro")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Registro de auditoría" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filtrar por acción…")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saAudit.", "sa."])).toEqual([]);
  });

  it("reads the controls hub in Spanish", async () => {
    mockFetch({ "GET /api/v2/dashboard/summary": { body: {
      role: "superadmin", total_stores: 42, active_stores: 37, trial_stores: 5,
      paid_stores: 30, inactive_stores: 2, mrr_total: 1234, arr_total: 14808,
      new_stores_30d: 6, cancellations_30d: 1, retention_queue: 3,
    } } });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("Tiendas en total")).toBeInTheDocument();
    expect(screen.getByText("Cola de retención")).toBeInTheDocument();
    expect(screen.getByText("Próximamente")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saCtl."])).toEqual([]);
  });

  it("reads the email log in Spanish; an unknown event shows as sent", async () => {
    mockFetch({ "GET /api/v2/superadmin/email-log": { body: {
      rows: [
        { id: 1, to_addr: "ana@x.test", event_type: "email.bounced", bounce_type: "hard",
          message_id: "msg_0123456789abcdefXYZ", created_at: "2026-10-09T15:00:00" },
        { id: 2, to_addr: "bo@x.test", event_type: "email.deferred", bounce_type: "",
          message_id: "", created_at: "2026-10-09T15:00:00" },
      ],
      total: 2, page: 1, total_pages: 1,
      suppressed: [{ user_id: 5, username: "ana", email: "ana@x.test", bounced_at: "2026-10-09" }],
    } } });
    renderRoute(<SuperadminEmailLog />);
    expect(await screen.findByRole("cell", { name: "Rebotado" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "deferred" })).toBeInTheDocument();
    expect(screen.getByText("2 eventos")).toBeInTheDocument();
    expect(screen.getByText("Direcciones bloqueadas (1)")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Destinatario" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saEmail."])).toEqual([]);
  });

  it("reads system health in Spanish, setting names kept", async () => {
    mockFetch({ "GET /api/v2/superadmin/system-health": { body: {
      db: { ok: true, error: "", total_users: 10, total_stores: 4, total_transfers: 99 },
      stripe: { ok: true, error: "", account_id: "acct_1", mode: "live", key_pair_match: false,
        fc_ok: true, env: { STRIPE_SECRET_KEY: true }, price_ok: { basic: true } },
      email: { configured: false, status: "" },
      queue: { enabled: true, redis_configured: true },
      rate_limiting: { enabled: false },
      env: { python_version: "3.12", platform: "linux", server_time: "2026-10-13T12:00:00.000",
        database_url_set: true, secret_key_set: false, sentry_dsn_set: false, webauthn_rp_id: "dinerobook.com" },
    } } });
    renderRoute(<SuperadminHealth />);
    expect(await screen.findByText("Base de datos")).toBeInTheDocument();
    expect(screen.getByText("NO COINCIDEN")).toBeInTheDocument();
    expect(screen.getByText("Precio: basic")).toBeInTheDocument();
    expect(screen.getByText("Activada (Redis)")).toBeInTheDocument();
    expect(screen.getByText("SECRET_KEY")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saHealth."])).toEqual([]);
  });

  it("reads the platform reports errors in Spanish", async () => {
    mockFetch({ "GET /api/v2/superadmin/reports": { status: 403, body: { detail: "no" } } });
    renderRoute(<SuperadminReports />);
    expect(await screen.findByText("Se requiere acceso de superusuario.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reportes de la plataforma" })).toBeInTheDocument();
  });
});

import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("lists entries and filters by action on Enter", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/audit-log": { body: LOG } });
    renderRoute(<SuperadminAuditLog />);
    expect(await screen.findByText("store.extend_trial")).toBeInTheDocument();
    expect(screen.getByText("+14 days")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Filter by action…"), "store{Enter}");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("action") === "store"),
    ).toBe(true));
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
  it("renders platform metrics and the hubs", async () => {
    mockFetch({
      "GET /api/v2/dashboard/summary": {
        body: { role: "superadmin", total_stores: 42, mrr_total: 1234, retention_queue: 2 },
      },
    });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("$1,234")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Audit Log/ })).toBeInTheDocument();
  });

  it("offers a retry when the metrics fail", async () => {
    mockFetch({ "GET /api/v2/dashboard/summary": { status: 500, body: {} } });
    renderRoute(<SuperadminControls />);
    expect(await screen.findByText("Couldn't load metrics for the overview.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
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
    expect(await screen.findByText("bounced")).toBeInTheDocument();
    expect(screen.getByText("Suppressed addresses (1)")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox"), "email.bounced");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("event_type") === "email.bounced"),
    ).toBe(true));
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
    expect(await screen.findByText("bounced")).toBeInTheDocument();
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

  it("creates a store with its first login and returns to the list", async () => {
    const calls = mockFetch({ "POST /api/v2/superadmin/stores": { body: STORE } });
    renderRoute(<SuperadminStoreForm />, { path: "/superadmin/stores/new" });
    expect(screen.getByRole("button", { name: "Create store" })).toBeDisabled();
    await fillCreate();
    await userEvent.click(screen.getByRole("button", { name: "Create store" }));
    expect(await screen.findByText("Navigated to /superadmin/stores")).toBeInTheDocument();
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

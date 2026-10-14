import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AccountActivity from "./AccountActivity";
import AccountNotifications from "./AccountNotifications";
import AccountSessions from "./AccountSessions";
import AdminReferrals from "./AdminReferrals";
import SupportTickets from "./SupportTickets";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The personal account pages (and the store's referral page). Pinned
// for each: the server's data renders, a failed load offers a retry,
// the write succeeds with a toast or shows the server's refusal, and
// the role gates (referrals: store admin/owner; tickets: superadmin
// goes to the platform inbox).

const push = vi.hoisted(() => ({
  supported: false,
  subscribed: false,
  subscribeBrowser: vi.fn(),
}));
vi.mock("../lib/push", () => ({
  pushSupported: () => push.supported,
  getPushPermission: () => "default",
  hasLocalSubscription: async () => push.subscribed,
  subscribeBrowser: (...a: unknown[]) => push.subscribeBrowser(...a),
  unsubscribeBrowser: async () => "https://push.example/ep",
}));

beforeEach(() => {
  push.supported = false;
  push.subscribed = false;
  push.subscribeBrowser.mockReset().mockResolvedValue({
    endpoint: "https://push.example/ep", p256dh: "k", auth: "a", userAgent: "UA",
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

function failThenServe(body: unknown) {
  const state = { fail: true };
  const handler: MockHandler = () => (state.fail
    ? { status: 500, body: { detail: "Database unavailable." } }
    : { body });
  return { state, handler };
}

describe("AccountSessions", () => {
  const SESSIONS = {
    sessions: [
      { session_id: "s-here", is_current: true, ip_address: "10.0.0.1",
        user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/120.0",
        started_at: "2026-10-01T15:00:00", last_used_at: "2026-10-01T15:00:00" },
      { session_id: "s-phone", is_current: false, ip_address: "10.0.0.2",
        user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
        started_at: "2026-10-01T15:00:00", last_used_at: "2026-10-01T15:00:00" },
    ],
  };

  it("lists devices; only the other one can be signed out", async () => {
    mockFetch({ "GET /api/v2/auth/sessions": { body: SESSIONS } });
    renderRoute(<AccountSessions />);
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
    expect(screen.getByText("Safari on iPhone")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
  });

  it("signs one session out", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/sessions": { body: SESSIONS },
      "DELETE /api/v2/auth/sessions/s-phone": { body: { revoked: 1 } },
    });
    renderRoute(<AccountSessions />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Session signed out.")).toBeInTheDocument();
    expect(callsTo(calls, "DELETE /api/v2/auth/sessions/s-phone")).toHaveLength(1);
  });

  it("signs out everywhere else after confirming", async () => {
    mockFetch({
      "GET /api/v2/auth/sessions": { body: SESSIONS },
      "DELETE /api/v2/auth/sessions/others": { body: { revoked: 1 } },
    });
    renderRoute(<AccountSessions />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out everywhere else" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign out everywhere else" }));
    expect(await screen.findByText("Signed out 1 other session.")).toBeInTheDocument();
  });

  it("shows a refused sign-out", async () => {
    mockFetch({
      "GET /api/v2/auth/sessions": { body: SESSIONS },
      "DELETE /api/v2/auth/sessions/s-phone": { status: 404, body: { detail: "Session not found." } },
    });
    renderRoute(<AccountSessions />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Session not found.")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(SESSIONS);
    mockFetch({ "GET /api/v2/auth/sessions": handler });
    renderRoute(<AccountSessions />);
    expect(await screen.findByText("Couldn't load sessions. Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
  });
});

describe("AccountActivity", () => {
  const ACT = {
    rows: [{ ts: "2026-10-09T15:00:00", user_name: "admin", action: "transfer.update",
      target_type: "transfer", target_id: "9", target_label: "#9", summary: "Fee 5 → 6",
      source: "transfer", store_name: "Uno" }],
    total: 1, page: 1, total_pages: 1,
  };

  it("lists my events and filters by target", async () => {
    const calls = mockFetch({ "GET /api/v2/auth/activity": { body: ACT } });
    renderRoute(<AccountActivity />);
    expect(await screen.findByText("Fee 5 → 6")).toBeInTheDocument();
    expect(screen.getByText("1 event")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Target"), "batch");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("target") === "batch"),
    ).toBe(true));
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/auth/activity": { body: { ...ACT, rows: [], total: 0 } } });
    renderRoute(<AccountActivity />);
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(ACT);
    mockFetch({ "GET /api/v2/auth/activity": handler });
    renderRoute(<AccountActivity />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Fee 5 → 6")).toBeInTheDocument();
  });
});

describe("AccountNotifications", () => {
  const PREFS = {
    role: "employee",
    trial_toggle_applies: false, locked_day_digest_applies: false,
    daily_summary_applies: false, high_variance_applies: false, store_offline_applies: false,
    notify_trial_reminders: false, notify_announcement_email: false,
    notify_locked_day_digest: false, notify_daily_summary: false,
    notify_trial_reminders_push: false, notify_announcement_push: true,
    notify_locked_day_digest_push: false, notify_daily_summary_push: false,
    notify_high_variance: false, notify_high_variance_push: false,
    notify_store_offline: false, notify_store_offline_push: false,
    notify_ticket_updates: true, notify_ticket_updates_push: false,
  };

  it("disables the toggles that don't apply to the role", async () => {
    mockFetch({ "GET /api/v2/auth/notifications": { body: PREFS } });
    renderRoute(<AccountNotifications />);
    expect(await screen.findByLabelText("Email — Trial-ending reminder")).toBeDisabled();
    expect(screen.getByLabelText("Email — Daily summary")).toBeDisabled();
    expect(screen.getByLabelText("Email — Platform announcements")).toBeEnabled();
    expect(screen.queryByLabelText("Email — High over/short alert")).not.toBeInTheDocument();
    expect(screen.getByText(/doesn't support push notifications/)).toBeInTheDocument();
  });

  it("saves the edited preferences", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/notifications": { body: PREFS },
      "PUT /api/v2/auth/notifications": { body: PREFS },
    });
    renderRoute(<AccountNotifications />);
    await userEvent.click(await screen.findByLabelText("Email — Platform announcements"));
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Notification preferences saved.")).toBeInTheDocument();
    expect(callsTo(calls, "PUT /api/v2/auth/notifications")[0].body).toMatchObject({
      notify_announcement_email: true, notify_ticket_updates: true,
    });
  });

  it("shows a refused save", async () => {
    mockFetch({
      "GET /api/v2/auth/notifications": { body: PREFS },
      "PUT /api/v2/auth/notifications": { status: 422, body: { detail: "Not applicable to your role." } },
    });
    renderRoute(<AccountNotifications />);
    await userEvent.click(await screen.findByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Not applicable to your role.")).toBeInTheDocument();
  });

  it("enables browser push on this device", async () => {
    push.supported = true;
    const calls = mockFetch({
      "GET /api/v2/auth/notifications": { body: PREFS },
      "GET /api/v2/auth/push/status": {
        body: { enabled: true, public_key: "pk", subscribed: false, device_count: 0 },
      },
      "POST /api/v2/auth/push/subscribe": {
        body: { enabled: true, public_key: "pk", subscribed: true, device_count: 1 },
      },
    });
    renderRoute(<AccountNotifications />);
    await userEvent.click(await screen.findByRole("button", { name: "Enable browser notifications" }));
    expect(await screen.findByText("Browser notifications enabled on this device.")).toBeInTheDocument();
    expect(push.subscribeBrowser).toHaveBeenCalledWith("pk");
    expect(callsTo(calls, "POST /api/v2/auth/push/subscribe")[0].body).toEqual({
      endpoint: "https://push.example/ep", p256dh: "k", auth: "a", user_agent: "UA",
    });
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(PREFS);
    mockFetch({ "GET /api/v2/auth/notifications": handler });
    renderRoute(<AccountNotifications />);
    expect(await screen.findByText("Couldn't load preferences. Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Save preferences" })).toBeInTheDocument();
  });
});

describe("AdminReferrals", () => {
  const REF = {
    code: "CAMBIO50", share_url: "https://dinerobook.com/signup?ref=CAMBIO50",
    reward_self_cents: 10000, reward_referee_cents: 5000,
    redeemed_count: 1, credits_earned_cents: 10000, is_active: true,
    redemptions: [{ referee_store_id: 42, redeemed_at: "2026-10-01", self_credit_applied: true,
      referee_credit_applied: false, stripe_self_txn_id: "cbtxn_1" }],
  };

  it("shows the code, credits and history", async () => {
    mockFetch({ "GET /api/v2/admin/referrals": { body: REF } });
    renderRoute(<AdminReferrals />);
    expect(await screen.findByText("CAMBIO50")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("Credited")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("offers the plans when the store is not on a paid plan (409)", async () => {
    mockFetch({ "GET /api/v2/admin/referrals": { status: 409, body: { detail: "Paid plan required" } } });
    renderRoute(<AdminReferrals />);
    expect(await screen.findByText("Unlock referrals on a paid plan")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /See plans/ })).toBeInTheDocument();
  });

  it("refuses an employee", () => {
    signInAs({ role: "employee" });
    mockFetch({ "GET /api/v2/admin/referrals": { body: REF } });
    renderRoute(<AdminReferrals />);
    expect(screen.getByText("You need a store-admin sign-in to manage referrals.")).toBeInTheDocument();
  });

  it("offers a retry on any other failure", async () => {
    const { state, handler } = failThenServe(REF);
    mockFetch({ "GET /api/v2/admin/referrals": handler });
    renderRoute(<AdminReferrals />);
    expect(await screen.findByText("Database unavailable.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("CAMBIO50")).toBeInTheDocument();
  });
});

describe("SupportTickets", () => {
  const TICKETS = {
    tickets: [{ id: 3, category: "bug", subject: "Receipt prints twice", status: "in_progress",
      created_at: "2026-10-09T15:00:00", unread_count: 0, body: "Details", messages: [] }],
  };

  it("lists my tickets", async () => {
    mockFetch({ "GET /api/v2/tickets": { body: TICKETS } });
    renderRoute(<SupportTickets />);
    expect(await screen.findByText("Receipt prints twice")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText("Bug report")).toBeInTheDocument();
  });

  it("files a ticket", async () => {
    const calls = mockFetch({
      "GET /api/v2/tickets": { body: TICKETS },
      "POST /api/v2/tickets": { body: { ticket: TICKETS.tickets[0] } },
    });
    renderRoute(<SupportTickets />);
    await userEvent.click(await screen.findByRole("button", { name: "+ New ticket" }));
    await userEvent.selectOptions(screen.getByLabelText("Category"), "feature");
    await userEvent.type(screen.getByLabelText("Subject"), "Dark mode PDFs");
    await userEvent.type(screen.getByLabelText("Description"), "Please.");
    await userEvent.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(await screen.findByText("Ticket submitted — we'll get back to you soon.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/tickets")[0].body).toEqual({
      category: "feature", subject: "Dark mode PDFs", body: "Please.",
    });
  });

  it("shows a refused ticket and keeps the form", async () => {
    mockFetch({
      "GET /api/v2/tickets": { body: TICKETS },
      "POST /api/v2/tickets": { status: 422, body: { detail: "Subject too long." } },
    });
    renderRoute(<SupportTickets />);
    await userEvent.click(await screen.findByRole("button", { name: "+ New ticket" }));
    await userEvent.type(screen.getByLabelText("Subject"), "x");
    await userEvent.type(screen.getByLabelText("Description"), "y");
    await userEvent.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(await screen.findByText("Subject too long.")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("x");
  });

  it("sends the superadmin to the platform inbox", () => {
    signInAs({ role: "superadmin", store_id: null, permissions: [] });
    mockFetch({});
    renderRoute(<SupportTickets />);
    expect(screen.getByText("Navigated to /superadmin/tickets")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(TICKETS);
    mockFetch({ "GET /api/v2/tickets": handler });
    renderRoute(<SupportTickets />);
    expect(await screen.findByText("Could not load tickets.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Receipt prints twice")).toBeInTheDocument();
  });
});

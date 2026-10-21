import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminEmailLog from "./SuperadminEmailLog";
import { callsTo, mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Platform → Email log. Pinned: the shared table and pager (row
// count, rows per page), filters in the URL reaching the API, the
// suppressed-address list, the error with retry, superadmin only.

const event = (id: number, to: string, type = "email.delivered", bounce = "") => ({
  id, to_addr: to, event_type: type, bounce_type: bounce,
  message_id: "msg_1234567890abcdefgh", created_at: "2026-10-08T12:00:00",
});

function log(extra: Record<string, unknown> = {}) {
  return {
    rows: [event(1, "ana@x.com"), event(2, "luis@x.com", "email.bounced", "hard")],
    total: 2, page: 1, total_pages: 1, suppressed: [],
    ...extra,
  };
}

function renderPage(at = "/superadmin/email-log") {
  return renderRoute(<SuperadminEmailLog />, { path: "/superadmin/email-log", at });
}

describe("SuperadminEmailLog", () => {
  beforeEach(() => {
    signInAs({ role: "superadmin", store_id: null });
    localStorage.removeItem("db.page_size.email-log");
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lists events with their type and bounce", async () => {
    mockFetch({ "GET /api/v2/superadmin/email-log": { body: log() } });
    renderPage();
    const luis = (await screen.findByText("luis@x.com")).closest("tr")!;
    expect(luis).toHaveTextContent("bounced");
    expect(luis).toHaveTextContent("hard");
    expect(screen.getByText("Showing 1–2 of 2")).toBeInTheDocument();
    expect(screen.getByText("2 events")).toBeInTheDocument();
  });

  it("asks for 50 rows a page and pages on", async () => {
    const calls = mockFetch({
      "GET /api/v2/superadmin/email-log": { body: log({ total: 120, total_pages: 3 }) },
    });
    renderPage();
    await screen.findByText("ana@x.com");
    expect(callsTo(calls, "GET /api/v2/superadmin/email-log")[0].url.searchParams.get("per_page")).toBe("50");
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(
      callsTo(calls, "GET /api/v2/superadmin/email-log").at(-1)!.url.searchParams.get("page"),
    ).toBe("2"));
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => {
      const last = callsTo(calls, "GET /api/v2/superadmin/email-log").at(-1)!.url.searchParams;
      expect(last.get("per_page")).toBe("100");
      expect(last.get("page")).toBeNull();
    });
  });

  it("sends the URL's filters to the API", async () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/email-log": { body: log() } });
    renderPage("/superadmin/email-log?q=ana&event_type=email.bounced");
    await screen.findByText("ana@x.com");
    const qs = callsTo(calls, "GET /api/v2/superadmin/email-log")[0].url.searchParams;
    expect(qs.get("q")).toBe("ana");
    expect(qs.get("event_type")).toBe("email.bounced");
    expect(screen.getByLabelText("Event")).toHaveValue("email.bounced");
  });

  it("lists suppressed addresses", async () => {
    mockFetch({
      "GET /api/v2/superadmin/email-log": {
        body: log({ suppressed: [{ user_id: 4, username: "gus", email: "gus@x.com", bounced_at: "2026-10-01T00:00:00" }] }),
      },
    });
    renderPage();
    expect(await screen.findByText("Suppressed addresses (1)")).toBeInTheDocument();
    expect(screen.getByText("gus")).toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", async () => {
    mockFetch({ "GET /api/v2/superadmin/email-log": { body: log({ rows: [], total: 0 }) } });
    renderPage();
    expect(await screen.findByText("No email events match the filters.")).toBeInTheDocument();
  });

  it("shows the server's error with a retry", async () => {
    mockFetch({ "GET /api/v2/superadmin/email-log": { status: 500, body: { detail: "Log store down" } } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Log store down");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does not load for anyone but a superadmin", () => {
    const calls = mockFetch({ "GET /api/v2/superadmin/email-log": { body: log() } });
    signInAs();
    renderPage();
    expect(callsTo(calls, "GET /api/v2/superadmin/email-log")).toHaveLength(0);
  });
});

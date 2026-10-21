import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import OwnerActivity from "./OwnerActivity";
import { mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Owner activity stream: one feed across the umbrella, on the shared
// audit table (store AND actor columns), searched as you type, paged
// with the shared pager and rows-per-page picker.

const page = (n: number) => ({
  rows: [{
    type: "transfer", store_id: 2, store_name: "Plaza Fiesta",
    user_name: "Rosa", user_role: "", action: "created",
    target_type: "transfer", target_label: "41",
    summary: `created transfer on page ${n}`, created_at: "2026-10-08T14:00:00",
  }],
  total: 75, page: n, total_pages: 2,
});

describe("Owner activity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.owner-activity");
  });

  it("asks for nothing unless an owner (or superadmin) is signed in", () => {
    const calls = mockFetch({ "GET /api/v2/owner/activity": { body: page(1) } });
    renderRoute(<OwnerActivity />);
    expect(calls).toHaveLength(0);
  });

  it("lists store and actor, and pages with the shared pager", async () => {
    signInAs({ role: "owner" });
    const calls = mockFetch({
      "GET /api/v2/owner/activity": (req) => ({
        body: page(Number(req.url.searchParams.get("page"))),
      }),
    });
    const user = userEvent.setup();
    renderRoute(<OwnerActivity />);
    expect(await screen.findByText("created transfer on page 1")).toBeInTheDocument();
    expect(screen.getByText("Plaza Fiesta")).toBeInTheDocument();
    expect(screen.getByText("Rosa")).toBeInTheDocument();
    expect(screen.getByText("Transfer #41")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Store" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actor" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 75")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("created transfer on page 2")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() =>
      expect(calls.at(-1)!.url.searchParams.get("per_page")).toBe("100"));
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("1");
  });

  it("searches as you type, from two characters", async () => {
    signInAs({ role: "owner" });
    const calls = mockFetch({ "GET /api/v2/owner/activity": { body: page(1) } });
    renderRoute(<OwnerActivity />);
    await screen.findByText("created transfer on page 1");
    await userEvent.setup().type(screen.getByLabelText("Search"), "ro");
    await waitFor(() =>
      expect(calls.at(-1)!.url.searchParams.get("q")).toBe("ro"));
  });

  it("offers a retry when the feed fails", async () => {
    signInAs({ role: "owner" });
    mockFetch({ "GET /api/v2/owner/activity": { status: 500, body: { detail: "down" } } });
    renderRoute(<OwnerActivity />);
    expect(await screen.findByText("Could not load activity.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

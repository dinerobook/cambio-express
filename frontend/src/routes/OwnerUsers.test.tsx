import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import OwnerUsers from "./OwnerUsers";
import { mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Owner's team users across the umbrella: owner-only query, shared
// table + pager, live search, rows per page.

const body = (n: number) => ({
  rows: [
    { id: 1, username: "rosa", full_name: "Rosa Diaz", role: "employee", is_active: true, store_id: 2, store_name: "Plaza" },
    { id: 2, username: "tom", full_name: "", role: "admin", is_active: false, store_id: 3, store_name: "Mall" },
  ],
  total: 52, page: n, total_pages: 2,
});

describe("Owner team users", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.owner-users");
  });

  it("asks for nothing unless an owner is signed in", () => {
    const calls = mockFetch({ "GET /api/v2/owner/users": { body: body(1) } });
    renderRoute(<OwnerUsers />);
    expect(calls).toHaveLength(0);
  });

  it("lists users with role and status, and pages", async () => {
    signInAs({ role: "owner" });
    const calls = mockFetch({
      "GET /api/v2/owner/users": (req) => ({ body: body(Number(req.url.searchParams.get("page"))) }),
    });
    const user = userEvent.setup();
    renderRoute(<OwnerUsers />);
    const rosa = (await screen.findByText("Rosa Diaz")).closest("tr")!;
    expect(rosa).toHaveTextContent("Active");
    expect(screen.getByText("tom").closest("tr")).toHaveTextContent("Inactive");
    expect(screen.getByText("Showing 1–2 of 52")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("page")).toBe("2"));
    await user.type(screen.getByLabelText("Search"), "ro");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("q")).toBe("ro"));
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("1");
  });

  it("says so when nobody matches, and retries a failed load", async () => {
    signInAs({ role: "owner" });
    mockFetch({ "GET /api/v2/owner/users": { body: { rows: [], total: 0, page: 1, total_pages: 1 } } });
    const { unmount } = renderRoute(<OwnerUsers />);
    expect(await screen.findByText("No matching users across your stores.")).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    mockFetch({ "GET /api/v2/owner/users": { status: 500, body: { detail: "x" } } });
    renderRoute(<OwnerUsers />);
    expect(await screen.findByText("Could not load users.")).toBeInTheDocument();
  });
});

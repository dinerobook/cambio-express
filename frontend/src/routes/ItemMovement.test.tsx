import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import ItemMovement from "./ItemMovement";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";

// Item movement: shared table, flags items missing from the price
// book, live search and rows per page reach the API.

const body = (over: Record<string, unknown> = {}) => ({
  start: "2026-10-01", end: "2026-10-07",
  rows: [
    { pos_code: "0001", merchandise_code: "1", description: "Coke 20oz", quantity: 12, amount: 30, avg_price: 2.5, in_price_book: true },
    { pos_code: "0002", merchandise_code: "1", description: "", quantity: 1, amount: 4, avg_price: 4, in_price_book: false },
  ],
  total: 60, page: 1, total_pages: 2, total_quantity: 13, total_amount: 34,
  ...over,
});

describe("Item movement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.item-movement");
  });

  it("lists items and flags the ones not in the price book", async () => {
    mockFetch({ "GET /api/v2/posimport/item-movement": { body: body() } });
    renderRoute(<ItemMovement />);
    expect(await screen.findByText("Coke 20oz")).toBeInTheDocument();
    expect(screen.getByText("0002").closest("tr")).toHaveTextContent("not in price book");
    expect(screen.getByText("0001").closest("tr")).not.toHaveTextContent("not in price book");
    expect(screen.getByText("Showing 1–2 of 60")).toBeInTheDocument();
  });

  it("searches as you type and changes rows per page", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/item-movement": { body: body() } });
    const user = userEvent.setup();
    renderRoute(<ItemMovement />);
    await screen.findByText("Coke 20oz");
    await user.type(screen.getByLabelText("Search"), "co");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("q")).toBe("co"));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("per_page")).toBe("100"));
  });

  it("says so when the range is empty", async () => {
    mockFetch({ "GET /api/v2/posimport/item-movement": { body: body({ rows: [], total: 0, total_pages: 1 }) } });
    renderRoute(<ItemMovement />);
    expect(await screen.findByText("No movement in this range")).toBeInTheDocument();
  });
});

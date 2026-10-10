import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoreBookMonth from "./StoreBookMonth";
import type { StoreBookMonth as StoreBookMonthData } from "../api/storebook";

// The store daily-book month calendar. Pinned: cents render as
// dollars (KPIs + day cells), month navigation wraps the year and
// lives in the URL, each day links to its sheet, and a failed load
// shows ErrorState with Retry.

const useStoreBookMonth = vi.fn();
const refetch = vi.fn();
let state: { data?: StoreBookMonthData; isLoading: boolean; isError: boolean };

vi.mock("../api/storebook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/storebook")>();
  return {
    ...real,
    useStoreBookMonth: (y: number, m: number) => {
      useStoreBookMonth(y, m);
      return { ...state, refetch };
    },
  };
});

function LocationProbe() {
  return <p data-testid="loc">{useLocation().search}</p>;
}

function renderPage(url = "/store-book?year=2026&month=12") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <StoreBookMonth />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("StoreBookMonth", () => {
  beforeEach(() => {
    useStoreBookMonth.mockReset();
    refetch.mockReset();
    state = {
      data: {
        year: 2026, month: 12,
        total_sales_cents: 1234567, total_fuel_gallons: 4321, total_fuel_cents: 987650,
        rows: [{
          entry_date: "2026-12-03", sales_cents: 196300, over_short_cents: -2463,
          is_locked: true, deposit_cents: 0, tenders_cents: 0,
        }],
      },
      isLoading: false, isError: false,
    };
  });

  it("shows the month's totals in dollars", () => {
    renderPage();
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2026, 12);
    expect(screen.getByText("Total sales").parentElement).toHaveTextContent("$12,345.67");
    expect(screen.getByText("Total fuel").parentElement).toHaveTextContent("$9,876.50");
    expect(screen.getByText("Total gallons").parentElement).toHaveTextContent("4,321");
  });

  it("links each day to its sheet and shows that day's sales", () => {
    renderPage();
    const day = screen.getByRole("link", { name: /2026-12-03/ });
    expect(day).toHaveAttribute("href", "/store-book/day?date=2026-12-03");
    expect(day).toHaveTextContent("$1,963.00");
  });

  it("wraps forward into January of the next year", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("year=2027&month=1");
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2027, 1);
  });

  it("wraps back into December of the previous year", async () => {
    renderPage("/store-book?year=2026&month=1");
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2025, 12);
  });

  it("jumps to a month picked from the select", async () => {
    renderPage();
    await userEvent.selectOptions(screen.getByRole("combobox"), "March");
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2026, 3);
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this month.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});

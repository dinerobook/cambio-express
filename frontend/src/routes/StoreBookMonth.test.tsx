import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoreBookMonth from "./StoreBookMonth";

// The store daily book's month page:
//   - The month in the URL decides what is asked of the server.
//   - Previous / next and the month picker move the URL (the year
//     rolls over at either end).
//   - A day with a sheet links to it and shows its sales.
//   - A failed load is an ErrorState with retry.

const useStoreBookMonth = vi.fn();

vi.mock("../api/storebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/storebook")>()),
  useStoreBookMonth: (...a: unknown[]) => useStoreBookMonth(...a),
}));

const month = {
  rows: [{
    entry_date: "2026-10-07", sales_cents: 123456, over_short_cents: -250,
    is_locked: true,
  }],
  total_sales_cents: 123456,
  total_fuel_gallons: 1500,
  total_fuel_cents: 450000,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url = "/store-book?year=2026&month=10") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <StoreBookMonth />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StoreBookMonth", () => {
  beforeEach(() => {
    useStoreBookMonth.mockReset();
    useStoreBookMonth.mockReturnValue({
      data: month, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("loads the month in the URL and links each day to its sheet", () => {
    renderPage();
    expect(useStoreBookMonth).toHaveBeenCalledWith(2026, 10);
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByText("Total sales").parentElement).toHaveTextContent("$1,234.56");
    const day = screen.getByRole("link", { name: "Open the daily book for 2026-10-07" });
    expect(day).toHaveAttribute("href", "/store-book/day?date=2026-10-07");
    expect(day).toHaveTextContent("$1,234.56");
  });

  it("steps months with the arrows and rolls the year over", async () => {
    const user = userEvent.setup();
    renderPage("/store-book?year=2026&month=12");
    await user.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2027&month=1");
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2027, 1);
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2026&month=11");
  });

  it("jumps to a month picked from the list, keeping the year", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(screen.getByRole("combobox", { name: "Month" }), "March");
    expect(screen.getByTestId("where")).toHaveTextContent("month=3");
    expect(screen.getByTestId("where")).toHaveTextContent("year=2026");
    expect(useStoreBookMonth).toHaveBeenLastCalledWith(2026, 3);
  });

  it("shows a retryable error when the month fails to load", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    useStoreBookMonth.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
    });
    renderPage();
    expect(screen.getByText("Couldn't load this month.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText("Total sales")).not.toBeInTheDocument();
  });
});

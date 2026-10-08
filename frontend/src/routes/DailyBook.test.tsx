import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DailyBook from "./DailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// The MSB Daily Book landing page: a calendar of the chosen month,
// a monthly summary strip, and each day a link to that day's editor.
//   - The month in the URL decides the range asked of the server.
//   - Previous / next step the month (and roll the year over).
//   - A day with a report shows its net figure; every day links to
//     the editor — but only for someone who may edit.
//   - A failed month load is an ErrorState with retry.

const useDailyPeriod = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyPeriod: (...a: unknown[]) => useDailyPeriod(...a),
  };
});

const period = {
  rows: [
    {
      id: 1, store_id: 1, report_date: "2026-10-07",
      total_receipts: 1500, total_disbursements: 500, over_short: -2.5,
      locked: true,
    },
    {
      id: 2, store_id: 1, report_date: "2026-10-08",
      total_receipts: 300, total_disbursements: 100, over_short: 0,
      locked: false,
    },
  ],
  total_receipts: 1800,
  total_disbursements: 600,
  net: 1200,
  days_logged: 2,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage(url = "/daily?year=2026&month=10") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <DailyBook />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DailyBook landing", () => {
  beforeEach(() => {
    useDailyPeriod.mockReset();
    useDailyPeriod.mockReturnValue({
      data: period, isLoading: false, isError: false, refetch: vi.fn(),
    });
  });

  it("asks the server for exactly the month in the URL", () => {
    renderPage();
    expect(useDailyPeriod).toHaveBeenCalledWith("2026-10-01", "2026-10-31");
    expect(screen.getByText("October 2026")).toBeInTheDocument();
  });

  it("shows the month's summary strip", () => {
    renderPage();
    expect(screen.getByText("Days logged").parentElement).toHaveTextContent("2 / 31");
    expect(screen.getByText("Total in").parentElement).toHaveTextContent("$1,800");
    expect(screen.getByText("Total out").parentElement).toHaveTextContent("$600");
    expect(screen.getByText("Net").parentElement).toHaveTextContent("$1,200");
  });

  it("links each day to its editor and shows the day's net", () => {
    renderPage();
    const day = screen.getByRole("link", { name: "Open daily book for 2026-10-07" });
    expect(day).toHaveAttribute("href", "/daily/edit?date=2026-10-07");
    expect(day).toHaveTextContent("$1,000");
    // A day nobody has logged yet is still a way in.
    expect(
      screen.getByRole("link", { name: "Open daily book for 2026-10-20" }),
    ).toHaveAttribute("href", "/daily/edit?date=2026-10-20");
  });

  it("steps to the previous and next month", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2026");
    expect(screen.getByTestId("where")).toHaveTextContent("month=11");
    expect(useDailyPeriod).toHaveBeenLastCalledWith("2026-11-01", "2026-11-30");
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("month=9");
    expect(useDailyPeriod).toHaveBeenLastCalledWith("2026-09-01", "2026-09-30");
  });

  it("rolls the year over at the ends of the year", async () => {
    renderPage("/daily?year=2026&month=1");
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByTestId("where")).toHaveTextContent("year=2025");
    expect(screen.getByTestId("where")).toHaveTextContent("month=12");
    expect(useDailyPeriod).toHaveBeenLastCalledWith("2025-12-01", "2025-12-31");
  });

  it("shows a retryable error when the month fails to load", async () => {
    const refetch = vi.fn();
    useDailyPeriod.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new Error("Month unavailable"), refetch,
    });
    renderPage();
    expect(screen.getByText("Month unavailable")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText("Days logged")).not.toBeInTheDocument();
  });

  it("does not link days for someone who cannot open the editor", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["daily_book.read"],
    });
    renderPage();
    expect(screen.queryByRole("link", { name: /Open daily book for/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Today" })).not.toBeInTheDocument();
  });
});

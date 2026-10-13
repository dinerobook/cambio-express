import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// How the editable form is built from the server's report:
//   - a failed load shows an error with Retry, never a blank zero form
//     whose Save / Lock would PUT zeros over the real day;
//   - a refetch (a line item was added / edited / removed) keeps what
//     the operator typed but has not saved yet;
//   - the "Saved hh:mm" pill belongs to the day it was saved on.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const updateDailyReport = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: (date?: string) => useDailyReport(date),
    useLineItems: () => LINES,
    useMTBreakdown: () => MT,
    useOpenSettlements: () => NOTHING_OPEN,
    updateDailyReport: (...a: unknown[]) => updateDailyReport(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const LINES = { data: { items: [] } };
const NOTHING_OPEN = { data: [], isError: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };

function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false, isError: false };
}

function tree() {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/daily/edit?date=${DAY}`]}>
        <EditDailyBook />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setCurrentIdentity(TEST_ADMIN);
  useDailyReport.mockReset();
  updateDailyReport.mockReset().mockResolvedValue({});
});

describe("EditDailyBook — failed load", () => {
  it("shows an error with Retry and no form to save over the day", async () => {
    const refetch = vi.fn();
    useDailyReport.mockReturnValue({
      data: undefined, isLoading: false, isFetching: false, isError: true,
      refetch,
    });
    render(tree());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load this day's book.",
    );
    expect(screen.queryByRole("button", { name: /Save daily book/ }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Lock/ }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    expect(updateDailyReport).not.toHaveBeenCalled();
  });

  it("renders the form once the day loads", () => {
    useDailyReport.mockReturnValue(savedDay({ taxable_sales: 500 }));
    render(tree());
    expect(screen.getByRole("button", { name: /Save daily book/ }))
      .toBeInTheDocument();
  });
});

describe("EditDailyBook — refetch keeps unsaved edits", () => {
  it("keeps typed notes when a line-item change refetches the day", async () => {
    useDailyReport.mockReturnValue(savedDay({}));
    const { rerender } = render(tree());
    const notes = screen.getByPlaceholderText(/cash drop at 2pm/);
    await userEvent.type(notes, "drawer short $5");
    // A line item was added: the report comes back with a new
    // line-item-derived total and nothing else changed.
    useDailyReport.mockReturnValue(savedDay({ cash_purchases: 50 }));
    rerender(tree());
    expect(screen.getByPlaceholderText(/cash drop at 2pm/))
      .toHaveValue("drawer short $5");
    // ...and Save still sends them.
    await userEvent.click(screen.getByRole("button", { name: /Save daily book/ }));
    await waitFor(() => expect(updateDailyReport).toHaveBeenCalled());
    expect(updateDailyReport.mock.calls[0].at(-1))
      .toMatchObject({ notes: "drawer short $5" });
  });

  it("takes the server's values when nothing is unsaved", () => {
    useDailyReport.mockReturnValue(savedDay({ notes: "first" }));
    const { rerender } = render(tree());
    useDailyReport.mockReturnValue(savedDay({ notes: "from another tab" }));
    rerender(tree());
    expect(screen.getByPlaceholderText(/cash drop at 2pm/))
      .toHaveValue("from another tab");
  });
});

describe("EditDailyBook — Saved pill", () => {
  it("does not follow the operator to another day", async () => {
    const days = new Map<string | undefined, ReturnType<typeof savedDay>>();
    useDailyReport.mockImplementation((date?: string) => {
      if (!days.has(date)) days.set(date, savedDay({ report_date: date }));
      return days.get(date);
    });
    render(tree());
    await userEvent.click(screen.getByRole("button", { name: /Save daily book/ }));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() =>
      expect(screen.getAllByText(/Oct 7/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/^Saved /)).not.toBeInTheDocument();
  });
});

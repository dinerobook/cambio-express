import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// The In column no longer offers Bill payment charge, Phone recargas
// or Boost Mobile as their own boxes. A day that already has one of
// them saved keeps showing that box (and only that one), so the old
// amount stays visible, counts in In and can still be corrected, and
// Save keeps sending it back unchanged.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const updateDailyReport = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
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

// Stable objects: the page syncs local drafts from these in effects.
const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const LINES = { data: { items: [] } };
const NOTHING_OPEN = { data: [], isError: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };
const NEW_DAY = { data: null, isLoading: false, isFetching: false };

// A saved day; every money field not named is zero.
function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false };
}

const RETIRED = [/^Bill payment charge/, /^Phone recargas/, /^Boost Mobile/];

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/daily/edit?date=${DAY}`]}>
        <EditDailyBook />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  updateDailyReport.mockReset().mockResolvedValue({});
});

describe("EditDailyBook — retired In boxes", () => {
  it("shows none of the three on a new day", () => {
    useDailyReport.mockReturnValue(NEW_DAY);
    renderPage();
    for (const name of RETIRED) {
      expect(screen.queryByLabelText(name)).not.toBeInTheDocument();
    }
    // The rest of Other receipts is still there.
    expect(screen.getByLabelText(/Forward balance/)).toBeInTheDocument();
  });

  it("shows none of the three on a saved day without them", () => {
    useDailyReport.mockReturnValue(savedDay({ taxable_sales: 500 }));
    renderPage();
    for (const name of RETIRED) {
      expect(screen.queryByLabelText(name)).not.toBeInTheDocument();
    }
  });

  it("keeps the box on a past day that has an amount, and only that one", () => {
    useDailyReport.mockReturnValue(savedDay({ phone_recargas: 25 }));
    renderPage();
    expect(screen.getByLabelText(/^Phone recargas/)).toHaveValue("25");
    expect(screen.queryByLabelText(/^Bill payment charge/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Boost Mobile/)).not.toBeInTheDocument();
  });

  it("still counts the old amount in In", () => {
    useDailyReport.mockReturnValue(savedDay({ boost_mobile: 40, money_transfer: 100 }));
    renderPage();
    expect(screen.getAllByText("$140.00").length).toBeGreaterThan(0);
  });

  it("saves the old amount back unchanged", async () => {
    useDailyReport.mockReturnValue(savedDay({ bill_payment_charge: 12.5 }));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Save daily book/ }));
    await waitFor(() => expect(updateDailyReport).toHaveBeenCalled());
    const body = updateDailyReport.mock.calls[0].at(-1);
    expect(body).toMatchObject({
      bill_payment_charge: 12.5, phone_recargas: 0, boost_mobile: 0,
    });
  });

  it("refuses edits to the kept box on a locked day", () => {
    useDailyReport.mockReturnValue(savedDay({
      phone_recargas: 25, locked: true, locked_at: `${DAY}T20:00:00`,
    }));
    renderPage();
    expect(screen.getByLabelText(/^Phone recargas/)).toBeDisabled();
  });
});

describe("EditDailyBook — In box names", () => {
  it("reads Cash In and Cash from Bank", () => {
    useDailyReport.mockReturnValue(NEW_DAY);
    renderPage();
    for (const name of [/^Cash In/, /^Cash from Bank/, /^Services/]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of [/^Other cash in/i, /^Cash from bank/, /^Money transfer/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

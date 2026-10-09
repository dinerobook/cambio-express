import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// The MSB daily book's one standard box (DailyBookTile): name, status
// pills beside it, the total, and a stacked breakdown pill per part —
// on EVERY box, so the parts read without opening anything. "Owed to
// us" and "We owe" are tabs of Cash In and Cash Out, not boxes of
// their own, and the section headings are gone.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => LINES,
    useMTBreakdown: () => MT,
    useOpenSettlements: () => NOTHING_OPEN,
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

const MT = {
  data: { rows: [], services: [], saved_total: 0, auto_total: 0, money_order_companies: [] },
  isLoading: false, isFetching: false,
};
const LINES = { data: { items: [] } };
const NOTHING_OPEN = { data: [], isError: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };

function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false };
}

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

const IN_BOXES = [
  "Sales", "Fees", "Services", "Cash from Bank", "Cash In", "Return check payback",
];
const OUT_BOXES = [
  "Payroll", "Purchases", "Expenses", "Check Deposits", "Cash Drops", "Cash Out",
];
const tile = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  useDailyReport.mockReturnValue(savedDay({}));
});

describe("EditDailyBook — one standard box", () => {
  it("gives every box a breakdown, in the standard order", () => {
    renderPage();
    const all = [...IN_BOXES, ...OUT_BOXES].map(tile);
    for (const el of all) {
      expect(el.querySelector(".ds-breakdown__pill")).not.toBeNull();
    }
    for (let i = 1; i < IN_BOXES.length; i++) {
      expect(all[i - 1].compareDocumentPosition(all[i]) & Node.DOCUMENT_POSITION_FOLLOWING)
        .toBeTruthy();
    }
  });

  it("shows Sales' parts on the closed box", () => {
    useDailyReport.mockReturnValue(savedDay({
      taxable_sales: 1640, non_taxable: 711, sales_tax: 135.3,
    }));
    renderPage();
    expect(tile("Sales")).toHaveTextContent("$2,486.30");
    expect(within(tile("Sales")).getByText("Taxable")).toHaveTextContent("$1,640.00");
    expect(within(tile("Sales")).getByText("Non-taxable")).toHaveTextContent("$711.00");
    expect(within(tile("Sales")).getByText("Sales tax")).toHaveTextContent("$135.30");
  });

  it("has no Owed to us / We owe boxes and no section headings", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /^Owed to us/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^We owe/ })).not.toBeInTheDocument();
    expect(within(tile("Cash In")).getByText("Owed to us")).toBeInTheDocument();
    expect(within(tile("Cash Out")).getByText("We owe")).toBeInTheDocument();
    expect(screen.queryByText(/Logged entries/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Auto-summed entries/i)).not.toBeInTheDocument();
  });

  it("marks only the box another page fills as Auto, locked day included", () => {
    useDailyReport.mockReturnValue(savedDay({
      locked: true, locked_at: `${DAY}T20:00:00`,
    }));
    renderPage();
    expect(within(tile("Return check payback")).getByText("Auto")).toBeInTheDocument();
    for (const name of ["Cash from Bank", "Cash Drops", "Cash In", "Cash Out"]) {
      expect(within(tile(name)).queryByText("Auto")).not.toBeInTheDocument();
    }
  });

  it("marks a carried forward balance Auto, but not one set by hand", () => {
    useDailyReport.mockReturnValue(savedDay({ forward_balance_auto: true }));
    const { unmount } = renderPage();
    const label = () => screen.getByText("Forward balance").closest("label")!;
    expect(within(label()).getByText("Auto")).toBeInTheDocument();
    unmount();

    useDailyReport.mockReturnValue(savedDay({
      forward_balance_auto: true, forward_balance_overridden: true,
    }));
    renderPage();
    expect(within(label()).queryByText("Auto")).not.toBeInTheDocument();
  });
});

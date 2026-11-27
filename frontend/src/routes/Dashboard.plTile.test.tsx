import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Dashboard from "./Dashboard";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { AdminDashboard, DashboardPLMonth } from "../api/dashboard";

// The Monthly P&L tile on the admin dashboard (owner, 2026-11-27):
//   - grant: an Admin's payload carries `pl_month`, the tile renders
//     FIRST with net profit, income, expenses and the days entered,
//     and links to the full P&L;
//   - the "to reconcile" pill shows only when there is something to
//     reconcile, and opens Bank transactions;
//   - an empty month says so instead of showing $0 figures;
//   - deny: no `pl_month` (every non-Admin, or an Admin without the
//     P&L) = no tile at all; a person who cannot open /monthly or
//     /bank-transactions never sees those links.

const useDashboardSummary = vi.fn();

vi.mock("../api/dashboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dashboard")>();
  return { ...real, useDashboardSummary: () => useDashboardSummary() };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, useStoreInfo: () => ({ data: undefined }) };
});

const PL: DashboardPLMonth = {
  year: 2026, month: 11, total_income: 14341.75, total_expenses: 4996.68,
  net_profit: 9345.07, days_entered: 26, to_reconcile: 5,
};

function admin(pl: DashboardPLMonth | null): AdminDashboard {
  return {
    role: "admin", today: "2026-11-26", modules: [],
    day_close: null, lottery: null, sales: null, purchases: null,
    clocked_in: [], register: null, recent_receipts: [],
    transfers_rollup: null, pl_month: pl,
    kpis: {
      total_transfers: 0, today_transfers: 0, pending_ach: 0,
      today_report_entered: false, net_income_month: pl?.net_profit ?? null,
    },
    company_stats: [], recent_transfers: [], recent_batches: [],
    stripe_accounts: [],
  } as unknown as AdminDashboard;
}

const ok = (data: AdminDashboard) => ({
  data, isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Dashboard — Monthly P&L tile", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
  });

  it("shows the month's net, income, expenses and days, first in the row", () => {
    useDashboardSummary.mockReturnValue(ok(admin(PL)));
    renderPage();
    const tile = screen.getByTestId("pl-month-tile");
    expect(within(tile).getByText("Monthly P&L · November 2026")).toBeInTheDocument();
    expect(within(tile).getByText("$9,345.07")).toBeInTheDocument();
    expect(within(tile).getByText("$14,341.75")).toBeInTheDocument();
    expect(within(tile).getByText("$4,996.68")).toBeInTheDocument();
    expect(within(tile).getByText("Built from 26 days entered")).toBeInTheDocument();
    expect(within(tile).getByRole("link", { name: "Open P&L →" }))
      .toHaveAttribute("href", "/monthly");
    // First tile of the KPI row.
    expect(tile.parentElement?.firstElementChild).toBe(tile);
  });

  it("links the bank rows still to reconcile", () => {
    useDashboardSummary.mockReturnValue(ok(admin(PL)));
    renderPage();
    const link = screen.getByRole("link", { name: /5 bank transactions to reconcile/ });
    expect(link).toHaveAttribute("href", "/bank-transactions");
  });

  it("hides the pill when nothing is left, or the person cannot tag bank rows", () => {
    useDashboardSummary.mockReturnValue(ok(admin({ ...PL, to_reconcile: 0 })));
    const { unmount } = renderPage();
    expect(screen.queryByText(/to reconcile/)).not.toBeInTheDocument();
    unmount();
    useDashboardSummary.mockReturnValue(ok(admin({ ...PL, to_reconcile: null })));
    renderPage();
    expect(screen.queryByText(/to reconcile/)).not.toBeInTheDocument();
  });

  it("says nothing is entered yet instead of $0 figures", () => {
    useDashboardSummary.mockReturnValue(ok(admin({
      ...PL, total_income: 0, total_expenses: 0, net_profit: 0,
      days_entered: 0, to_reconcile: null,
    })));
    renderPage();
    const tile = screen.getByTestId("pl-month-tile");
    expect(within(tile).getByText("Nothing entered yet")).toBeInTheDocument();
    expect(within(tile).queryByText("$0.00")).not.toBeInTheDocument();
    expect(within(tile).queryByText(/Income/)).not.toBeInTheDocument();
  });

  it("paints a loss in the loss colour", () => {
    useDashboardSummary.mockReturnValue(ok(admin({
      ...PL, total_income: 100, total_expenses: 350, net_profit: -250,
    })));
    renderPage();
    expect(screen.getByText("-$250.00")).toBeInTheDocument();
  });

  it("renders no tile when the server sends none (every non-Admin)", () => {
    useDashboardSummary.mockReturnValue(ok(admin(null)));
    renderPage();
    expect(screen.queryByTestId("pl-month-tile")).not.toBeInTheDocument();
    expect(screen.queryByText(/Monthly P&L/)).not.toBeInTheDocument();
    // The old small Net income tile is gone too.
    expect(screen.queryByText(/Net income/)).not.toBeInTheDocument();
  });

  it("hides links the person cannot open", () => {
    setCurrentIdentity({
      ...TEST_ADMIN,
      permissions: TEST_ADMIN.permissions.filter(
        (p) => !p.startsWith("monthly.") && !p.startsWith("bank_sync."),
      ),
    });
    useDashboardSummary.mockReturnValue(ok(admin(PL)));
    renderPage();
    expect(screen.queryByRole("link", { name: "Open P&L →" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /to reconcile/ })).not.toBeInTheDocument();
  });
});

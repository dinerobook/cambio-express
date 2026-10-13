import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Dashboard from "./Dashboard";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { EmployeeDashboard, EmployeeTodayRow } from "../api/dashboard";

// The employee dashboard's "Today's transfers" (it had no test):
//   - each row is listed, a payout or a debit card send marked as such;
//   - "Today Total Sent" leaves payouts out, which get their own
//     "Paid Out" total, shown only on a day that has one;
//   - none of it shows when the store has money services off.

const useDashboardSummary = vi.fn();

vi.mock("../api/dashboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dashboard")>();
  return { ...real, useDashboardSummary: () => useDashboardSummary() };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, useStoreInfo: () => ({ data: undefined }) };
});

const row = (over: Partial<EmployeeTodayRow>): EmployeeTodayRow => ({
  id: 1, created_at: null, sender_name: "Ana", company: "Intermex",
  service_type: "Money Transfer", payment_method: "cash",
  send_amount: 100, fee: 5, recipient_name: "Luis", country: "Mexico",
  confirm_number: "C1", status: "Sent", ...over,
});

function summary(over: Partial<EmployeeDashboard> = {}): EmployeeDashboard {
  return {
    role: "employee", today: "2026-10-13",
    modules: ["module_money_services"],
    day_close: null, lottery: null, register: null,
    today_transfers: [
      row({ id: 1, sender_name: "Cash Sender" }),
      row({ id: 2, sender_name: "Card Sender", send_amount: 40, fee: 2,
            payment_method: "debit_card" }),
      row({ id: 3, sender_name: "Paid Here", send_amount: 250, fee: 0,
            service_type: "Payout" }),
    ],
    totals: { sent: 140, paid_out: 250, fees: 7, count: 3 },
    ...over,
  };
}

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

const ok = (data: EmployeeDashboard) => ({
  data, isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

describe("Employee dashboard — today's transfers", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee" });
  });

  it("lists today's rows and marks payouts and debit card sends", () => {
    useDashboardSummary.mockReturnValue(ok(summary()));
    renderPage();
    const tr = (name: string) => screen.getByText(name).closest("tr")!;
    expect(within(tr("Paid Here")).getByText("Payout")).toBeInTheDocument();
    expect(within(tr("Card Sender")).getByText("Debit card")).toBeInTheDocument();
    expect(within(tr("Cash Sender")).queryByText("Payout")).not.toBeInTheDocument();
    expect(within(tr("Cash Sender")).queryByText("Debit card")).not.toBeInTheDocument();
  });

  it("keeps payouts out of Total Sent and shows them as Paid Out", () => {
    useDashboardSummary.mockReturnValue(ok(summary()));
    renderPage();
    expect(screen.getByText("Today Total Sent:").parentElement)
      .toHaveTextContent("$140.00");
    expect(screen.getByText("Paid Out:").parentElement)
      .toHaveTextContent("$250.00");
  });

  it("hides Paid Out on a day with no payouts", () => {
    useDashboardSummary.mockReturnValue(ok(summary({
      today_transfers: [row({})],
      totals: { sent: 100, paid_out: 0, fees: 5, count: 1 },
    })));
    renderPage();
    expect(screen.getByText("Today Total Sent:")).toBeInTheDocument();
    expect(screen.queryByText("Paid Out:")).not.toBeInTheDocument();
  });

  it("shows no transfers at all when money services are off", () => {
    useDashboardSummary.mockReturnValue(ok(summary({ modules: [] })));
    renderPage();
    expect(screen.queryByText("Cash Sender")).not.toBeInTheDocument();
    expect(screen.queryByText("Today Total Sent:")).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { MTBreakdownRow, MTServiceRow } from "../api/dailybook";

// The In column's Services box (was "Money transfer"):
//   - Closed, it shows the day's total and, when services are saved,
//     how it splits ("Transfers $X · Bill payments $Y").
//   - Open, it has a tab per service: Money transfer (amount / fees /
//     federal tax / commission), Bill payments, Top-ups, Recharges
//     (amount / fee), and a By company table adding each company's
//     transfers and services.
//   - Save sends transfers and every non-zero service line.
//   - A locked day can be read but not changed.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const useMTBreakdown = vi.fn();
const replaceMTBreakdown = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => LINES,
    useMTBreakdown: () => useMTBreakdown(),
    useOpenSettlements: () => NOTHING_OPEN,
    replaceMTBreakdown: (...a: unknown[]) => replaceMTBreakdown(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

// Stable objects: the page syncs local drafts from these in effects.
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

const mtRow = (company: string, saved: Partial<MTBreakdownRow> = {}): MTBreakdownRow => {
  const r = {
    company, saved_amount: 0, saved_fees: 0, saved_federal_tax: 0,
    saved_commission: 0, auto_amount: 0, auto_fees: 0, auto_federal_tax: 0,
    auto_commission: 0, auto_count: 0, auto_total: 0, ...saved,
  };
  return {
    ...r,
    saved_total: r.saved_amount + r.saved_fees + r.saved_federal_tax + r.saved_commission,
  };
};

function breakdown(rows: MTBreakdownRow[], services: MTServiceRow[] = []) {
  return {
    data: { rows, services, saved_total: 0, auto_total: 0 },
    isLoading: false, isFetching: false,
  };
}

const MAXI_TRANSFERS = { saved_amount: 800, saved_fees: 40, saved_federal_tax: 8 };
const MAXI_BILL: MTServiceRow = {
  company: "Maxi", service: "bill_payment", amount: 120, fees: 3,
};
const NO_SERVICES = breakdown([mtRow("Intermex"), mtRow("Maxi", MAXI_TRANSFERS)]);
const WITH_BILL = breakdown(
  [mtRow("Intermex"), mtRow("Maxi", MAXI_TRANSFERS)], [MAXI_BILL],
);

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

const box = () => screen.getByRole("button", { name: /^Services/ });

async function openBox() {
  renderPage();
  await userEvent.click(box());
  return screen.getByRole("dialog");
}

function rowOf(dialog: HTMLElement, company: string, tableIndex = 0) {
  const table = within(dialog).getAllByRole("table")[tableIndex];
  return within(table).getByText(company).closest("tr") as HTMLElement;
}

async function typeInto(input: HTMLElement, value: string) {
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  replaceMTBreakdown.mockReset().mockResolvedValue({});
  useDailyReport.mockReturnValue(savedDay({ money_transfer: 848 }));
  useMTBreakdown.mockReturnValue(NO_SERVICES);
});

describe("EditDailyBook — Services box", () => {
  it("replaces the Money transfer box", () => {
    renderPage();
    expect(box()).toHaveTextContent("$848.00");
    expect(box()).toHaveTextContent("1 company");
    expect(screen.queryByRole("button", { name: /^Money transfer/ }))
      .not.toBeInTheDocument();
  });

  it("splits the closed total when services are saved", () => {
    useDailyReport.mockReturnValue(savedDay({ money_transfer: 971 }));
    useMTBreakdown.mockReturnValue(WITH_BILL);
    renderPage();
    expect(box()).toHaveTextContent("$971.00");
    expect(box()).toHaveTextContent("Transfers $848.00 · Bill payments $123.00");
  });

  it("has a tab for each service", async () => {
    const dialog = await openBox();
    const tabs = within(dialog).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "Money transfer · $848.00", "Bill payments · $0.00",
      "Top-ups · $0.00", "Recharges · $0.00",
    ]);
    expect(within(dialog).getByText("Federal tax")).toBeInTheDocument();
  });

  it("enters a bill payment and saves it with the transfers", async () => {
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Bill payments/ }));
    expect(within(dialog).queryByText("Federal tax")).not.toBeInTheDocument();
    const [amount, fee] = within(rowOf(dialog, "Maxi")).getAllByRole("textbox");
    await typeInto(amount, "120");
    await typeInto(fee, "3");

    // Maxi's company total is its transfers plus the bill payment.
    expect(rowOf(dialog, "Maxi", 1)).toHaveTextContent("$971.00");
    expect(within(dialog).getByRole("tab", { name: /^Bill payments/ }))
      .toHaveTextContent("$123.00");
    expect(within(dialog).getByText(/Grand total/)).toHaveTextContent("$971.00");

    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    await waitFor(() => expect(replaceMTBreakdown).toHaveBeenCalled());
    const [storeId, date, rows, services] = replaceMTBreakdown.mock.calls[0];
    expect([storeId, date]).toEqual([TEST_ADMIN.store_id, DAY]);
    expect(rows).toEqual([
      { company: "Intermex", amount: 0, fees: 0, federal_tax: 0, commission: 0 },
      { company: "Maxi", amount: 800, fees: 40, federal_tax: 8, commission: 0 },
    ]);
    expect(services).toEqual([MAXI_BILL]);
  });

  it("keeps recharges separate from top-ups", async () => {
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Recharges/ }));
    await typeInto(within(rowOf(dialog, "Intermex")).getAllByRole("textbox")[0], "25");
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Top-ups/ }));
    expect(within(rowOf(dialog, "Intermex")).getAllByRole("textbox")[0]).toHaveValue("");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    await waitFor(() => expect(replaceMTBreakdown).toHaveBeenCalled());
    expect(replaceMTBreakdown.mock.calls[0][3]).toEqual([
      { company: "Intermex", service: "recharge", amount: 25, fees: 0 },
    ]);
  });

  it("loads saved services and can clear them", async () => {
    useMTBreakdown.mockReturnValue(WITH_BILL);
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Bill payments/ }));
    const [amount, fee] = within(rowOf(dialog, "Maxi")).getAllByRole("textbox");
    expect(amount).toHaveValue("120");
    await userEvent.clear(amount);
    await userEvent.clear(fee);
    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    await waitFor(() => expect(replaceMTBreakdown).toHaveBeenCalled());
    expect(replaceMTBreakdown.mock.calls[0][3]).toEqual([]);
  });

  it("shows the save error and stays open", async () => {
    replaceMTBreakdown.mockRejectedValue(new Error("boom"));
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("can be read but not changed on a locked day", async () => {
    useDailyReport.mockReturnValue(savedDay({
      money_transfer: 971, locked: true, locked_at: `${DAY}T20:00:00`,
    }));
    useMTBreakdown.mockReturnValue(WITH_BILL);
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Bill payments/ }));
    for (const input of within(rowOf(dialog, "Maxi")).getAllByRole("textbox")) {
      expect(input).toBeDisabled();
    }
    expect(within(dialog).getByRole("button", { name: /Save services/ })).toBeDisabled();
    expect(replaceMTBreakdown).not.toHaveBeenCalled();
  });
});

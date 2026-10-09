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
//   - Closed, it shows the day's total and one breakdown pill per
//     tab (Money transfer, Bill payments, Top-ups, Recharges, Money
//     orders), zero ones faded.
//   - Open, it has a tab per service: Money transfer (amount / fees /
//     federal tax / commission), Bill payments, Top-ups, Recharges and
//     Money orders (amount / fee per company — money orders only for
//     the companies that sell them), and a By company table adding
//     each company's transfers and services.
//   - A day with money orders from before they were per company shows
//     them under "Earlier entries" on the Money orders tab, still
//     counted and editable.
//   - Save sends transfers and every non-zero service line, then
//     saves the day's form so an earlier money order fee is kept.
//   - A locked day can be read but not changed.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const useMTBreakdown = vi.fn();
const replaceMTBreakdown = vi.fn();
const updateDailyReport = vi.fn();
const createLineItem = vi.fn();
const useLineItems = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => useLineItems(),
    useMTBreakdown: () => useMTBreakdown(),
    useOpenSettlements: () => NOTHING_OPEN,
    replaceMTBreakdown: (...a: unknown[]) => replaceMTBreakdown(...a),
    updateDailyReport: (...a: unknown[]) => updateDailyReport(...a),
    createLineItem: (...a: unknown[]) => createLineItem(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

// Stable objects: the page syncs local drafts from these in effects.
const LINES = { data: { items: [] } };
const MONEY_ORDER_LINES = {
  data: {
    items: [{
      id: 7, kind: "money_order", at_time: "10:15", amount: 300, note: "MO #1",
      return_check_id: null, expects_settlement: false, settle_by: null,
      settled: 0, settles_item_id: null,
    }],
  },
};
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

function breakdown(
  rows: MTBreakdownRow[], services: MTServiceRow[] = [],
  moneyOrderCompanies: string[] = rows.map((r) => r.company),
) {
  return {
    data: {
      rows, services, saved_total: 0, auto_total: 0,
      money_order_companies: moneyOrderCompanies,
    },
    isLoading: false, isFetching: false,
  };
}

/** The tile's breakdown pill for one part. */
const part = (label: string) => within(box()).getByText(label);

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
  updateDailyReport.mockReset().mockResolvedValue({});
  createLineItem.mockReset().mockResolvedValue({});
  useLineItems.mockReturnValue(LINES);
  useDailyReport.mockReturnValue(savedDay({ money_transfer: 848 }));
  useMTBreakdown.mockReturnValue(NO_SERVICES);
});

describe("EditDailyBook — Services box", () => {
  it("replaces the Money transfer box", () => {
    renderPage();
    expect(box()).toHaveTextContent("$848.00");
    expect(part("Money transfer")).toHaveTextContent("$848.00");
    for (const label of ["Bill payments", "Top-ups", "Recharges", "Money orders"]) {
      expect(part(label)).toHaveAttribute("data-zero");
    }
    expect(screen.queryByRole("button", { name: /^Money transfer/ }))
      .not.toBeInTheDocument();
  });

  it("splits the closed total when services are saved", () => {
    useDailyReport.mockReturnValue(savedDay({ money_transfer: 971 }));
    useMTBreakdown.mockReturnValue(WITH_BILL);
    renderPage();
    expect(box()).toHaveTextContent("$971.00");
    expect(part("Money transfer")).toHaveTextContent("$848.00");
    expect(part("Bill payments")).toHaveTextContent("$123.00");
    expect(part("Bill payments")).not.toHaveAttribute("data-zero");
  });

  it("has a tab for each service", async () => {
    const dialog = await openBox();
    const tabs = within(dialog).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual([
      "Money transfer · $848.00", "Bill payments · $0.00",
      "Top-ups · $0.00", "Recharges · $0.00", "Money orders · $0.00",
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
    // The day's form is saved too (it carries the money order fee).
    await waitFor(() => expect(updateDailyReport).toHaveBeenCalled());
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

  it("enters money orders per company and saves them as a service", async () => {
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    // Same table as the other services; no free-form entry list.
    expect(within(dialog).queryByRole("button", { name: /\+ Add/ })).not.toBeInTheDocument();
    const [amount, fee] = within(rowOf(dialog, "Intermex")).getAllByRole("textbox");
    await typeInto(amount, "400");
    await typeInto(fee, "6");
    expect(within(dialog).getByRole("tab", { name: /^Money orders/ }))
      .toHaveTextContent("$406.00");
    // Counts in Intermex's own total, like any service.
    expect(rowOf(dialog, "Intermex", 1)).toHaveTextContent("$406.00");

    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    await waitFor(() => expect(replaceMTBreakdown).toHaveBeenCalled());
    expect(replaceMTBreakdown.mock.calls[0][3]).toEqual([
      { company: "Intermex", service: "money_order", amount: 400, fees: 6 },
    ]);
  });

  it("lists only the companies that sell money orders", async () => {
    useMTBreakdown.mockReturnValue(breakdown(
      [mtRow("Intermex"), mtRow("Maxi", MAXI_TRANSFERS)], [], ["Intermex"],
    ));
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    const table = within(dialog).getAllByRole("table")[0];
    expect(within(table).getByText("Intermex")).toBeInTheDocument();
    expect(within(table).queryByText("Maxi")).not.toBeInTheDocument();
    // Other services still list every company.
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Bill payments/ }));
    expect(within(within(dialog).getAllByRole("table")[0]).getByText("Maxi"))
      .toBeInTheDocument();
  });

  it("keeps a switched-off company's saved money orders on the tab", async () => {
    const maxiMo: MTServiceRow = {
      company: "Maxi", service: "money_order", amount: 170, fees: 4,
    };
    useMTBreakdown.mockReturnValue(breakdown(
      [mtRow("Intermex"), mtRow("Maxi")], [maxiMo], ["Intermex"],
    ));
    renderPage();
    expect(part("Money orders")).toHaveTextContent("$174.00");
    await userEvent.click(box());
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    expect(within(rowOf(dialog, "Maxi")).getAllByRole("textbox")[0]).toHaveValue("170");
  });

  it("says where to switch money orders on when no company sells them", async () => {
    useMTBreakdown.mockReturnValue(breakdown([mtRow("Intermex")], [], []));
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    expect(dialog).toHaveTextContent("No company sells money orders");
    expect(within(dialog).queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps an earlier day's money order entries and fee", async () => {
    useDailyReport.mockReturnValue(savedDay({
      money_transfer: 848, money_order: 300, money_order_fees: 4,
    }));
    useLineItems.mockReturnValue(MONEY_ORDER_LINES);
    renderPage();
    // The tile still adds them to the transfers.
    expect(box()).toHaveTextContent("$1,152.00");
    expect(part("Money orders")).toHaveTextContent("$304.00");
    expect(screen.queryByRole("button", { name: /^Money order/ })).not.toBeInTheDocument();

    await userEvent.click(box());
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    expect(within(dialog).getByText(/Earlier entries/)).toBeInTheDocument();
    expect(within(dialog).getByText("MO #1")).toBeInTheDocument();
    // Editable, but nothing new is added there.
    expect(within(dialog).queryByRole("button", { name: /\+ Add/ })).not.toBeInTheDocument();
    const fee = within(dialog).getByLabelText(/^Money order fees/);
    expect(fee).toHaveValue("4");
    await typeInto(fee, "6");
    expect(within(dialog).getByRole("tab", { name: /^Money orders/ }))
      .toHaveTextContent("$306.00");
    expect(within(dialog).getByText(/Grand total/)).toHaveTextContent("$1,154.00");

    await userEvent.click(within(dialog).getByRole("button", { name: /Save services/ }));
    await waitFor(() => expect(updateDailyReport).toHaveBeenCalled());
    expect(updateDailyReport.mock.calls[0].at(-1)).toMatchObject({ money_order_fees: 6 });
  });

  it("shows no Earlier entries on a day without them", async () => {
    const dialog = await openBox();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Money orders/ }));
    expect(within(dialog).queryByText(/Earlier entries/)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^Money order fees/)).not.toBeInTheDocument();
  });
});

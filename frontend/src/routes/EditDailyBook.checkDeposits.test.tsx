import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { addDaysIso, todayIso } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";
import type { LineItemRow, OpenSettlement } from "../api/dailybook";

// The Out column's boxes, and the Check Deposits box that holds both
// check deposits and checks on hold:
//   - Boxes read Cash Drops / Check Deposits / Cash Out; Payroll has
//     no "(P&L only)" suffix; the old Checks held / Checks on hand /
//     Held checks deposited boxes are gone.
//   - Closed, the box shows today's deposits + holds, and a pill when
//     checks are on hold (count, amount, overdue).
//   - Deposited tab: today's check deposits (plain add), and held
//     checks deposited today with no add row.
//   - On hold tab: every check on hand with Deposit, and the add row
//     for a check held today (no tick box, optional deposit-by date).
//   - A locked day offers no add row and no Deposit.

const DAY = todayIso();

const useDailyReport = vi.fn();
const useLineItems = vi.fn();
const useOpenSettlements = vi.fn();
const createLineItem = vi.fn();
const deleteLineItem = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => useLineItems(),
    useMTBreakdown: () => MT,
    useOpenSettlements: () => useOpenSettlements(),
    createLineItem: (...a: unknown[]) => createLineItem(...a),
    deleteLineItem: (...a: unknown[]) => deleteLineItem(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

// Stable objects: the page syncs local drafts from these in effects.
const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };
const NO_REPORT = { data: null, isLoading: false, isFetching: false };
const NOTHING_OPEN = { data: [], isError: false };
const NO_LINES = { data: { items: [] } };

// A saved day; every money field not named is zero.
function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false };
}
const SAVED = savedDay({
  checks_deposit: 1200, checks_held: 300, held_checks_deposited: 2500,
  payroll_expense: 400, payroll_check: 900,
});
const LOCKED = savedDay({ locked: true, locked_at: `${DAY}T20:00:00` });

const row = (over: Partial<LineItemRow>): LineItemRow => ({
  id: 1, kind: "check_hold", at_time: "", amount: 0, note: "",
  return_check_id: null, expects_settlement: true, settle_by: null,
  settled: 0, settles_item_id: null, ...over,
});

const hold = (over: Partial<OpenSettlement>): OpenSettlement => ({
  id: 31, kind: "check_hold", report_date: addDaysIso(DAY, -6),
  amount: 4000, note: "ABC Construction", settle_by: null,
  settled: 0, outstanding: 4000, returns: [], ...over,
});
const LENT: OpenSettlement = {
  ...hold({}), id: 40, kind: "other_cash_out", note: "Store #2",
  amount: 999, outstanding: 999,
};

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

const box = () => screen.getByRole("button", { name: /^Check Deposits/ });

async function openOnHold() {
  await userEvent.click(box());
  const dialog = screen.getByRole("dialog");
  await userEvent.click(within(dialog).getByRole("tab", { name: /^On hold/ }));
  return dialog;
}

describe("EditDailyBook — Out column boxes", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    useDailyReport.mockReturnValue(SAVED);
    useLineItems.mockReturnValue(NO_LINES);
    useOpenSettlements.mockReturnValue(NOTHING_OPEN);
  });

  it("uses the short box names and drops the separate held-check boxes", () => {
    renderPage();
    for (const name of [/^Cash Drops/, /^Check Deposits/, /^Cash Out/]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    for (const name of [
      /Outside cash/, /Other cash out/, /^Checks held/, /Checks on hand/,
      /Held checks deposited/,
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows payroll's cash and check without a P&L note", () => {
    renderPage();
    const payroll = screen.getByRole("button", { name: /^Payroll/ });
    expect(within(payroll).getByText("Cash")).toHaveTextContent("$400.00");
    expect(within(payroll).getByText("Check")).toHaveTextContent("$900.00");
    expect(payroll).not.toHaveTextContent("P&L");
  });
});

describe("EditDailyBook — Check Deposits box", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    createLineItem.mockReset().mockResolvedValue({});
    deleteLineItem.mockReset().mockResolvedValue(undefined);
    useDailyReport.mockReturnValue(NO_REPORT);
    useLineItems.mockReturnValue(NO_LINES);
    useOpenSettlements.mockReturnValue(NOTHING_OPEN);
  });

  it("totals what checks took out of the drawer today", () => {
    useDailyReport.mockReturnValue(SAVED);
    renderPage();
    expect(box()).toHaveTextContent("$1,500.00");
    expect(within(box()).getByText("Deposited")).toHaveTextContent("$1,200.00");
    expect(within(box()).getByText("Held today")).toHaveTextContent("$300.00");
    // Nothing on hold: the outlined pill stays, faded.
    expect(within(box()).getByText("On hold")).toHaveAttribute("data-zero");
  });

  it("shows no pill when no check is on hold", () => {
    useOpenSettlements.mockReturnValue({ data: [LENT], isError: false });
    renderPage();
    expect(box()).not.toHaveTextContent("on hold");
  });

  it("shows a pill with the checks on hold, leaving out later days", () => {
    useOpenSettlements.mockReturnValue({ data: [
      hold({ id: 31, outstanding: 1500 }),
      hold({ id: 32, outstanding: 700 }),
      hold({ id: 33, report_date: addDaysIso(DAY, 2), outstanding: 99 }),
      LENT,
    ], isError: false });
    renderPage();
    expect(box()).toHaveTextContent("2 on hold");
    const onHold = within(box()).getByText("On hold");
    expect(onHold).toHaveTextContent("$2,200.00");
    expect(onHold).toHaveAttribute("data-open");
    expect(box()).not.toHaveTextContent("overdue");
  });

  it("flags overdue checks on the pill", () => {
    useOpenSettlements.mockReturnValue({ data: [
      hold({ id: 31, settle_by: addDaysIso(DAY, -1) }),
      hold({ id: 32, settle_by: addDaysIso(DAY, 3) }),
    ], isError: false });
    renderPage();
    // Overdue wins the one status pill; the amount stays on the part.
    expect(box()).toHaveTextContent("1 overdue");
    expect(within(box()).getByText("On hold")).toHaveTextContent("$8,000.00");
  });

  it("opens on Deposited and adds a plain check deposit", async () => {
    renderPage();
    await userEvent.click(box());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("tab", { name: /^Deposited/ }))
      .toHaveAttribute("aria-selected", "true");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Deposit by")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "1200");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(
      1, DAY, { kind: "check_deposit", at_time: "", amount: 1200, note: "" },
    ));
  });

  it("lists held checks deposited today under Deposited, with no add row of their own", async () => {
    useDailyReport.mockReturnValue(SAVED);
    useLineItems.mockReturnValue({ data: { items: [
      row({ id: 5, kind: "check_deposit", amount: 1200, note: "Walk-in",
        expects_settlement: false }),
      row({ id: 7, kind: "held_check_deposit", amount: 2500, note: "ABC",
        expects_settlement: false, settles_item_id: 1 }),
    ] } });
    renderPage();
    await userEvent.click(box());
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("From checks on hold · $2,500.00");
    expect(dialog).toHaveTextContent("No cash effect");
    // One add row: the check deposit one.
    expect(within(dialog).getAllByRole("button", { name: "+ Add" })).toHaveLength(1);
    const tr = within(dialog).getByText("ABC").closest("tr")!;
    await userEvent.click(within(tr).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteLineItem).toHaveBeenCalledWith(1, 7));
  });

  it("lists checks on hand on the On hold tab and deposits one today", async () => {
    useOpenSettlements.mockReturnValue({ data: [
      hold({ id: 31, outstanding: 1500, settled: 2500 }), LENT,
    ], isError: false });
    renderPage();
    const dialog = await openOnHold();
    expect(within(dialog).queryByText("Store #2")).not.toBeInTheDocument();
    const tr = within(dialog).getByText("ABC Construction").closest("tr")!;
    await userEvent.click(within(tr).getByRole("button", { name: "Deposit" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    await userEvent.click(within(form).getByRole("button", { name: "Deposit" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(1, DAY, {
      kind: "held_check_deposit", at_time: "", amount: 1500,
      note: "ABC Construction", settles_item_id: 31,
    }));
  });

  it("explains how to start when nothing is on hold", async () => {
    renderPage();
    const dialog = await openOnHold();
    expect(dialog).toHaveTextContent("No checks on hand");
  });

  it("adds a hold with no tick box and no date", async () => {
    renderPage();
    const dialog = await openOnHold();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "4000");
    await userEvent.type(within(dialog).getByLabelText(/Note/), "ABC Construction");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(1, DAY, {
      kind: "check_hold", at_time: "", amount: 4000,
      note: "ABC Construction", expects_settlement: true, settle_by: null,
    }));
  });

  it("adds a hold with a deposit-by date, and the next add starts open again", async () => {
    renderPage();
    const dialog = await openOnHold();
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "900");
    await userEvent.type(within(dialog).getByLabelText("Deposit by"), "2026-10-15");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(
      1, DAY, expect.objectContaining({
        kind: "check_hold", expects_settlement: true, settle_by: "2026-10-15",
      }),
    ));
    expect(within(dialog).getByLabelText("Deposit by")).toHaveValue("");
  });

  it("shows how much of each hold made today is still to deposit", async () => {
    useLineItems.mockReturnValue({ data: { items: [
      row({ id: 1, amount: 4000, note: "ABC", settled: 2500 }),
      row({ id: 2, amount: 300, note: "Done", settled: 300 }),
    ] } });
    renderPage();
    const dialog = await openOnHold();
    expect(within(dialog).getByText("ABC").closest("tr"))
      .toHaveTextContent("On hand · $1,500.00 to deposit");
    expect(within(dialog).getByText("Done").closest("tr"))
      .toHaveTextContent("Deposited");
  });

  it("offers no add row or Deposit on a locked day", async () => {
    useDailyReport.mockReturnValue(LOCKED);
    useOpenSettlements.mockReturnValue({ data: [hold({})], isError: false });
    renderPage();
    await userEvent.click(box());
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "+ Add" })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("tab", { name: /^On hold/ }));
    expect(within(dialog).queryByRole("button", { name: "+ Add" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Deposit" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("ABC Construction")).toBeInTheDocument();
  });

  it("hides the add rows and Deposit from someone who may only read the book", async () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["daily_book.read"],
    });
    useOpenSettlements.mockReturnValue({ data: [hold({})], isError: false });
    renderPage();
    const dialog = await openOnHold();
    expect(within(dialog).getByText("ABC Construction")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Deposit" })).not.toBeInTheDocument();
  });
});

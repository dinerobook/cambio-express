import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import { setCurrentIdentity } from "../lib/auth";
import { todayIso } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";
import type { LineItemRow } from "../api/dailybook";

// The daily book's side of bank matching (BankSync "Matching"):
//   - an entry the bank has (added by the feed, or matched) shows a
//     green "In bank" pill; one the bank hasn't seen shows nothing;
//   - typing the amount the bank feed already put in that box asks
//     before adding the same money twice; "Don't add" adds nothing,
//     "Add anyway" adds it; a different amount adds straight away.

const DAY = todayIso();

const useDailyReport = vi.fn();
const useLineItems = vi.fn();
const createLineItem = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => useLineItems(),
    useMTBreakdown: () => MT,
    useOpenSettlements: () => NOTHING_OPEN,
    createLineItem: (...a: unknown[]) => createLineItem(...a),
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
const NOTHING_OPEN = { data: [], isError: false };

function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false };
}

const row = (over: Partial<LineItemRow>): LineItemRow => ({
  id: 1, kind: "drop", at_time: "", amount: 0, note: "",
  return_check_id: null, expects_settlement: false, settle_by: null,
  settled: 0, settles_item_id: null, ...over,
});

const FROM_BANK = row({
  id: 7, amount: 500, note: "ATM DEPOSIT", in_bank: "added", bank_date: DAY,
});
const MATCHED = row({ id: 8, amount: 320, note: "evening drop", in_bank: "matched" });
const NOT_YET = row({ id: 9, amount: 45, note: "morning drop" });

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

async function openDrops() {
  renderPage();
  await userEvent.click(screen.getByRole("button", { name: /^Cash Drops/ }));
  return screen.getByRole("dialog");
}

async function typeAmount(dialog: HTMLElement, value: string) {
  const amount = within(dialog).getByLabelText(/Amount/);
  await userEvent.clear(amount);
  await userEvent.type(amount, value);
  await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
}

describe("EditDailyBook — In bank", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    createLineItem.mockReset();
    createLineItem.mockResolvedValue(row({ id: 99 }));
    useDailyReport.mockReturnValue(savedDay({ outside_cash_drops: 865 }));
    useLineItems.mockReturnValue({ data: { items: [FROM_BANK, MATCHED, NOT_YET] } });
  });

  it("marks entries the bank has, and only those", async () => {
    const dialog = await openDrops();
    const pills = within(dialog).getAllByText("In bank");
    expect(pills).toHaveLength(2);
    const rowOf = (text: string) => within(dialog).getByText(text).closest("tr")!;
    expect(within(rowOf("ATM DEPOSIT")).getByText("In bank")).toBeInTheDocument();
    expect(within(rowOf("ATM DEPOSIT")).getByText("In bank").closest("[title]"))
      .toHaveAttribute("title", expect.stringContaining("Added by the bank feed"));
    expect(within(rowOf("evening drop")).getByText("In bank").closest("[title]"))
      .toHaveAttribute("title", "Matched to a bank transaction");
    expect(within(rowOf("morning drop")).queryByText("In bank")).not.toBeInTheDocument();
  });

  it("asks before adding the amount the bank already added", async () => {
    const dialog = await openDrops();
    await typeAmount(dialog, "500");
    const ask = await screen.findByRole("dialog", { name: "Already here from the bank?" });
    expect(ask).toHaveTextContent("already added $500.00");
    expect(createLineItem).not.toHaveBeenCalled();
    await userEvent.click(within(ask).getByRole("button", { name: "Don't add" }));
    expect(createLineItem).not.toHaveBeenCalled();
  });

  it("adds it anyway when the person says so", async () => {
    const dialog = await openDrops();
    await typeAmount(dialog, "500");
    const ask = await screen.findByRole("dialog", { name: "Already here from the bank?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Add anyway" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledTimes(1));
    expect(createLineItem.mock.calls[0][2]).toMatchObject({ kind: "drop", amount: 500 });
  });

  it("adds a different amount without asking (a matched entry never asks)", async () => {
    const dialog = await openDrops();
    await typeAmount(dialog, "320");
    await waitFor(() => expect(createLineItem).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: "Already here from the bank?" }))
      .not.toBeInTheDocument();
  });
});

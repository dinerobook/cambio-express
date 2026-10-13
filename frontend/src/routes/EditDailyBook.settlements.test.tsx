import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import type { LineItemRow, OpenSettlement } from "../api/dailybook";

// The daily book's entry boxes and money that comes back:
//   - Cash Out offers "Expected back", Cash In offers
//     "We pay this back"; no other box offers either.
//   - A plain add sends exactly what it always did.
//   - A ticked add sends the mark and the optional date.
//   - The entries table shows each entry's state.
//   - The "Owed to us" and "We owe" tiles sit on the day.
//   - A locked day is view only: no add row, no Edit / Remove, and
//     no Record / Change date / Close on what is still open (the
//     owner's report, 2026-10-13).

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const useLineItems = vi.fn();
const useOpenSettlements = vi.fn();
const createLineItem = vi.fn();
const updateLineItem = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => useLineItems(),
    useMTBreakdown: () => MT,
    useOpenSettlements: () => useOpenSettlements(),
    createLineItem: (...a: unknown[]) => createLineItem(...a),
    updateLineItem: (...a: unknown[]) => updateLineItem(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

// Stable objects: the page syncs local drafts from these in effects,
// so a fresh object per render would loop.
const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };
const NO_REPORT = { data: null, isLoading: false, isFetching: false };
const NOTHING_OPEN = { data: [], isError: false };

const row = (over: Partial<LineItemRow>): LineItemRow => ({
  id: 1, kind: "other_cash_out", at_time: "", amount: 0, note: "",
  return_check_id: null, expects_settlement: false, settle_by: null,
  settled: 0, settles_item_id: null, ...over,
});

const LINES = {
  data: {
    items: [
      row({ id: 1, amount: 2000, note: "Store #2", expects_settlement: true, settled: 500 }),
      row({ id: 2, amount: 40, note: "Ice" }),
      row({ id: 3, kind: "other_cash_in", amount: 300, note: "Back from Raj", settles_item_id: 9 }),
    ],
  },
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

async function openBox(name: RegExp) {
  await userEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

// A saved, locked day; every money field not named is zero.
const LOCKED = {
  data: new Proxy(
    { locked: true, locked_at: `${DAY}T20:00:00`, notes: "", report_date: DAY },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  ),
  isLoading: false, isFetching: false,
};

const open = (over: Partial<OpenSettlement>): OpenSettlement => ({
  id: 50, kind: "other_cash_out", report_date: "2026-10-03", amount: 600,
  note: "Lent to Store #2", settle_by: null, settled: 0, outstanding: 600,
  day_locked: true, returns: [], ...over,
});

describe("EditDailyBook — money that comes back", () => {
  beforeEach(() => {
    createLineItem.mockReset().mockResolvedValue({});
    updateLineItem.mockReset().mockResolvedValue({});
    useDailyReport.mockReturnValue(NO_REPORT);
    useLineItems.mockReturnValue(LINES);
    useOpenSettlements.mockReturnValue(NOTHING_OPEN);
  });


  it("puts the Owed to us and We owe tiles on the day", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /Owed to us/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /We owe/ })).toBeInTheDocument();
  });

  it("adds a plain cash out exactly as before", async () => {
    renderPage();
    const dialog = await openBox(/^Cash Out/);
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "50");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(
      1, DAY, { kind: "other_cash_out", at_time: "", amount: 50, note: "" },
    ));
  });

  it("marks a cash out as expected back with a date", async () => {
    renderPage();
    const dialog = await openBox(/^Cash Out/);
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "2000");
    await userEvent.type(within(dialog).getByLabelText(/Note/), "Lent to Store #2");
    expect(within(dialog).queryByLabelText("Settle by")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByLabelText("Expected back"));
    await userEvent.type(within(dialog).getByLabelText("Settle by"), "2026-10-08");
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(1, DAY, {
      kind: "other_cash_out", at_time: "", amount: 2000,
      note: "Lent to Store #2", expects_settlement: true,
      settle_by: "2026-10-08",
    }));
  });

  it("marks a borrowed cash in as paid back, date optional", async () => {
    renderPage();
    const dialog = await openBox(/^Cash In/);
    await userEvent.type(within(dialog).getByLabelText(/Amount/), "800");
    await userEvent.click(within(dialog).getByLabelText("We pay this back"));
    await userEvent.click(within(dialog).getByRole("button", { name: "+ Add" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(
      1, DAY, expect.objectContaining({
        kind: "other_cash_in", amount: 800,
        expects_settlement: true, settle_by: null,
      }),
    ));
  });

  it("does not offer the mark on other boxes", async () => {
    renderPage();
    const dialog = await openBox(/^Cash Drops/);
    expect(within(dialog).queryByLabelText("Expected back")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("We pay this back")).not.toBeInTheDocument();
  });

  it("shows each entry's state in the table", async () => {
    renderPage();
    const outDialog = await openBox(/^Cash Out/);
    const lentRow = within(outDialog).getByText("Store #2").closest("tr")!;
    expect(lentRow).toHaveTextContent("Expected back · $1,500.00 left");
    const plainRow = within(outDialog).getByText("Ice").closest("tr")!;
    expect(plainRow).not.toHaveTextContent("Expected back");
  });

  it("can close an entry from its inline edit", async () => {
    renderPage();
    const dialog = await openBox(/^Cash Out/);
    const lentRow = within(dialog).getByText("Store #2").closest("tr")!;
    await userEvent.click(within(lentRow).getByRole("button", { name: "Edit" }));
    const editRow = within(dialog).getByRole("button", { name: "Save" }).closest("tr")!;
    const editing = within(editRow).getByLabelText("Expected back");
    expect(editing).toBeChecked();
    await userEvent.click(editing);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLineItem).toHaveBeenCalledWith(
      1, 1, expect.objectContaining({
        expects_settlement: false, settle_by: null,
      }),
    ));
  });
  it("is view only on a locked day: entries and open items have no actions", async () => {
    useDailyReport.mockReturnValue(LOCKED);
    useOpenSettlements.mockReturnValue({
      data: [
        open({}),
        open({ id: 51, kind: "other_cash_in", note: "Borrowed from Ana" }),
      ],
      isError: false,
    });
    renderPage();
    for (const [box, openTab, item] of [
      [/^Cash Out/, /^We owe/, "Borrowed from Ana"],
      [/^Cash In/, /^Owed to us/, "Lent to Store #2"],
    ] as const) {
      const dialog = await openBox(box);
      expect(within(dialog).queryByRole("button", { name: "+ Add" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("tab", { name: openTab }));
      expect(within(dialog).getByText(item)).toBeInTheDocument();
      for (const name of ["Record return", "Record payback", "Change date", "Close"]) {
        expect(within(dialog).queryByRole("button", { name })).not.toBeInTheDocument();
      }
      expect(dialog).toHaveTextContent("This day is locked, so it is view only");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    }
    expect(updateLineItem).not.toHaveBeenCalled();
    expect(createLineItem).not.toHaveBeenCalled();
  });
});

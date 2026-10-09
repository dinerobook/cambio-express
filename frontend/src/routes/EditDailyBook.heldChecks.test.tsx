import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import type { LineItemRow } from "../api/dailybook";

// Held checks on the daily book page:
//   - Checks held is a box in Out with an optional deposit-by date and
//     no tick box: every entry in it is open.
//   - The Checks on hand tile sits on every day.
//   - Held checks deposited shows only on a day that has a deposit,
//     says it moves no cash, has no add row, and can still remove.

const DAY = "2026-10-09";

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

const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };
const NO_REPORT = { data: null, isLoading: false, isFetching: false };
const NOTHING_OPEN = { data: [], isError: false };
const NO_LINES = { data: { items: [] } };

const row = (over: Partial<LineItemRow>): LineItemRow => ({
  id: 1, kind: "check_hold", at_time: "", amount: 0, note: "",
  return_check_id: null, expects_settlement: true, settle_by: null,
  settled: 0, settles_item_id: null, ...over,
});

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

describe("EditDailyBook — held checks", () => {
  beforeEach(() => {
    createLineItem.mockReset().mockResolvedValue({});
    deleteLineItem.mockReset().mockResolvedValue(undefined);
    useDailyReport.mockReturnValue(NO_REPORT);
    useLineItems.mockReturnValue(NO_LINES);
    useOpenSettlements.mockReturnValue(NOTHING_OPEN);
  });

  it("puts Checks held and Checks on hand on the day", () => {
    renderPage();
    expect(screen.getByRole("button", { name: /^Checks held/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Checks on hand/ })).toBeInTheDocument();
    // No deposit today → no Held checks deposited tile.
    expect(screen.queryByRole("button", { name: /Held checks deposited/ }))
      .not.toBeInTheDocument();
  });

  it("adds a hold with no tick box and no date", async () => {
    renderPage();
    const dialog = await openBox(/^Checks held/);
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
    const dialog = await openBox(/^Checks held/);
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

  it("shows how much of each hold is still to deposit", async () => {
    useLineItems.mockReturnValue({ data: { items: [
      row({ id: 1, amount: 4000, note: "ABC", settled: 2500 }),
      row({ id: 2, amount: 300, note: "Done", settled: 300 }),
    ] } });
    renderPage();
    const dialog = await openBox(/^Checks held/);
    expect(within(dialog).getByText("ABC").closest("tr"))
      .toHaveTextContent("On hand · $1,500.00 to deposit");
    expect(within(dialog).getByText("Done").closest("tr"))
      .toHaveTextContent("Deposited");
  });

  it("shows today's held-check deposits as no-cash entries without an add row", async () => {
    useLineItems.mockReturnValue({ data: { items: [
      row({
        id: 7, kind: "held_check_deposit", amount: 2500, note: "ABC",
        expects_settlement: false, settles_item_id: 1,
      }),
    ] } });
    renderPage();
    const tile = screen.getByRole("button", { name: /Held checks deposited/ });
    expect(tile).toHaveTextContent("No cash effect");
    const dialog = await openBox(/Held checks deposited/);
    expect(within(dialog).queryByRole("button", { name: "+ Add" }))
      .not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(deleteLineItem).toHaveBeenCalledWith(1, 7));
  });
});

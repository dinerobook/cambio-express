import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SettlementPill, SettlementsList, SettlementsWidget,
} from "./DailyBookSettlements";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { addDaysIso, todayIso } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";
import type { LineItemRow, OpenSettlement } from "../api/dailybook";

// Money that comes back, in the daily book:
//   - "Owed to us" lists open Other cash outs, "We owe" open Other
//     cash ins, each only up to the day being viewed.
//   - The tile shows what is still out and how much is overdue.
//   - Record return books the opposite kind on the viewed day,
//     linked to the original; a partial amount is fine, more than
//     what's left is refused before the call.
//   - Close unticks the original after a confirm.
//   - A locked day, or someone without the right, gets no buttons.

const useOpenSettlements = vi.fn();
const createLineItem = vi.fn();
const updateLineItem = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useOpenSettlements: () => useOpenSettlements(),
    createLineItem: (...a: unknown[]) => createLineItem(...a),
    updateLineItem: (...a: unknown[]) => updateLineItem(...a),
  };
});

const TODAY = todayIso();
const VIEWED = TODAY;

const lent: OpenSettlement = {
  id: 11, kind: "other_cash_out", report_date: addDaysIso(TODAY, -4),
  amount: 2000, note: "Store #2 (Raj)", settle_by: addDaysIso(TODAY, -2),
  settled: 500, outstanding: 1500,
  returns: [{ id: 15, report_date: addDaysIso(TODAY, -2), amount: 500 }],
};
const lentNoDate: OpenSettlement = {
  id: 12, kind: "other_cash_out", report_date: addDaysIso(TODAY, -1),
  amount: 850, note: "Maria", settle_by: null,
  settled: 0, outstanding: 850, returns: [],
};
const lentLater: OpenSettlement = {
  id: 13, kind: "other_cash_out", report_date: addDaysIso(TODAY, 2),
  amount: 99, note: "After the viewed day", settle_by: null,
  settled: 0, outstanding: 99, returns: [],
};
const borrowed: OpenSettlement = {
  id: 21, kind: "other_cash_in", report_date: addDaysIso(TODAY, -3),
  amount: 800, note: "From Ana", settle_by: addDaysIso(TODAY, 5),
  settled: 0, outstanding: 800, returns: [],
};

function renderWidget(
  direction: "owed_to_us" | "we_owe" = "owed_to_us",
  { locked = false, onChange = vi.fn() } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SettlementsWidget
        direction={direction}
        storeId={1}
        date={VIEWED}
        locked={locked}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

// The checks-on-hand list lives in the Check Deposits box's On hold
// tab (EditDailyBook), so it is tested bare.
function renderList({ locked = false, onChange = vi.fn() } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <SettlementsList
        direction="checks_on_hand"
        storeId={1}
        date={VIEWED}
        locked={locked}
        onChange={onChange}
      />
    </QueryClientProvider>,
  );
  return { container, onChange };
}

async function openList(title: string) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(title) }));
  return screen.getByRole("dialog");
}

describe("SettlementsWidget", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    useOpenSettlements.mockReset();
    createLineItem.mockReset();
    updateLineItem.mockReset();
    useOpenSettlements.mockReturnValue({
      data: [lent, lentNoDate, lentLater, borrowed], isError: false,
    });
  });

  it("totals what is still owed up to the viewed day", () => {
    renderWidget();
    const tile = screen.getByRole("button", { name: /Owed to us/ });
    // 1,500 + 850; the entry made after the viewed day is left out.
    expect(tile).toHaveTextContent("$2,350.00");
    expect(tile).toHaveTextContent("2 open");
    expect(tile).toHaveTextContent("1 overdue");
  });

  it("lists borrowed money under We owe only", async () => {
    renderWidget("we_owe");
    const tile = screen.getByRole("button", { name: /We owe/ });
    expect(tile).toHaveTextContent("$800.00");
    expect(tile).not.toHaveTextContent("overdue");
    const dialog = await openList("We owe");
    expect(within(dialog).getByText("From Ana")).toBeInTheDocument();
    expect(within(dialog).queryByText("Maria")).not.toBeInTheDocument();
    expect(
      within(dialog).getAllByRole("button", { name: "Record payback" }),
    ).toHaveLength(1);
  });

  it("shows partial returns and the overdue date in the list", async () => {
    renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Store #2 (Raj)").closest("tr")!;
    expect(row).toHaveTextContent("$500.00 on");
    expect(row).toHaveTextContent("$1,500.00");
    expect(row).toHaveTextContent("overdue");
    expect(within(dialog).getByText("No date")).toBeInTheDocument();
    expect(within(dialog).queryByText("After the viewed day")).not.toBeInTheDocument();
  });

  it("says so when nothing is open", async () => {
    useOpenSettlements.mockReturnValue({ data: [], isError: false });
    renderWidget();
    expect(screen.getByRole("button", { name: /Owed to us/ }))
      .toHaveTextContent("Nothing open");
    const dialog = await openList("Owed to us");
    expect(dialog).toHaveTextContent("Nothing is owed to the store");
  });

  it("shows a load failure inside the list", async () => {
    useOpenSettlements.mockReturnValue({
      data: undefined, isError: true,
      error: new ApiError(500, "Server unavailable", null),
    });
    renderWidget();
    const dialog = await openList("Owed to us");
    expect(dialog).toHaveTextContent("Server unavailable");
  });

  it("records a partial return as a linked Other cash in on the viewed day", async () => {
    createLineItem.mockResolvedValue({});
    const { onChange } = renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Store #2 (Raj)").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Record return" }));

    const form = screen.getAllByRole("dialog").at(-1)!;
    const amount = within(form).getByLabelText(/Amount/);
    expect(amount).toHaveValue("1500");
    await userEvent.clear(amount);
    await userEvent.type(amount, "400");
    await userEvent.click(within(form).getByRole("button", { name: "Record return" }));

    await waitFor(() => expect(createLineItem).toHaveBeenCalledTimes(1));
    expect(createLineItem).toHaveBeenCalledWith(1, VIEWED, {
      kind: "other_cash_in", at_time: "", amount: 400,
      note: "Store #2 (Raj)", settles_item_id: 11,
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("pays borrowed money back as an Other cash out", async () => {
    createLineItem.mockResolvedValue({});
    renderWidget("we_owe");
    const dialog = await openList("We owe");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record payback" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    await userEvent.click(within(form).getByRole("button", { name: "Record payback" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(
      1, VIEWED, expect.objectContaining({
        kind: "other_cash_out", amount: 800, settles_item_id: 21,
      }),
    ));
  });

  it("refuses more than is outstanding without calling the server", async () => {
    renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Maria").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Record return" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    const amount = within(form).getByLabelText(/Amount/);
    await userEvent.clear(amount);
    await userEvent.type(amount, "900");
    await userEvent.click(within(form).getByRole("button", { name: "Record return" }));
    expect(form).toHaveTextContent("Only $850.00 is still outstanding.");
    expect(createLineItem).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when recording fails", async () => {
    createLineItem.mockRejectedValue(
      new ApiError(403, "Daily report is locked — unlock it before editing.", null),
    );
    renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Maria").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Record return" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    await userEvent.click(within(form).getByRole("button", { name: "Record return" }));
    expect(await within(form).findByText(/Daily report is locked/)).toBeInTheDocument();
  });

  it("closes an entry after confirming", async () => {
    updateLineItem.mockResolvedValue({});
    const { onChange } = renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Maria").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Close" }));
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    expect(confirm).toHaveTextContent("Nothing already booked changes.");
    await userEvent.click(within(confirm).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(updateLineItem).toHaveBeenCalledWith(
      1, 12, { expects_settlement: false },
    ));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("keeps the confirm open with the reason when closing fails", async () => {
    updateLineItem.mockRejectedValue(
      new ApiError(403, "Daily report is locked — unlock it before editing.", null),
    );
    renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Maria").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Close" }));
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    await userEvent.click(within(confirm).getByRole("button", { name: "Close" }));
    expect(await within(confirm).findByText(/unlock it before editing/)).toBeInTheDocument();
  });

  it("offers no Record on a locked day, but still Change date and Close", async () => {
    renderWidget("owed_to_us", { locked: true });
    const dialog = await openList("Owed to us");
    expect(within(dialog).queryByRole("button", { name: "Record return" }))
      .not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Change date" }))
      .toHaveLength(2);
    expect(within(dialog).getAllByRole("button", { name: "Close" }))
      .toHaveLength(2);
    expect(dialog).toHaveTextContent("This day is locked");
  });

  it("changes the date, or clears it", async () => {
    updateLineItem.mockResolvedValue({});
    const { onChange } = renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Store #2 (Raj)").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Change date" }));
    const form = screen.getByRole("dialog", { name: "Change date" });
    const input = within(form).getByLabelText("Settle by");
    expect(input).toHaveValue(lent.settle_by);
    await userEvent.clear(input);
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLineItem).toHaveBeenCalledWith(
      1, 11, { settle_by: null },
    ));
    await waitFor(() => expect(onChange).toHaveBeenCalled());

    updateLineItem.mockClear();
    await userEvent.click(within(row).getByRole("button", { name: "Change date" }));
    const again = screen.getByRole("dialog", { name: "Change date" });
    const field = within(again).getByLabelText("Settle by");
    await userEvent.clear(field);
    await userEvent.type(field, "2030-01-15");
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateLineItem).toHaveBeenCalledWith(
      1, 11, { settle_by: "2030-01-15" },
    ));
  });

  it("shows why a date change failed", async () => {
    updateLineItem.mockRejectedValue(
      new ApiError(409, "The settle-by date can't be before the entry's own day.", null),
    );
    renderWidget();
    const dialog = await openList("Owed to us");
    const row = within(dialog).getByText("Maria").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Change date" }));
    const form = screen.getByRole("dialog", { name: "Change date" });
    await userEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText(/can't be before/)).toBeInTheDocument();
  });

  it("hides the actions from someone who may only read the book", async () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["daily_book.read"],
    });
    renderWidget();
    const dialog = await openList("Owed to us");
    expect(within(dialog).getByText("Maria")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Record return" }))
      .not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Close" }))
      .not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Change date" }))
      .not.toBeInTheDocument();
  });

  it("lets someone with create but not update record and not close", async () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["daily_book.read", "daily_book.create"],
    });
    renderWidget();
    const dialog = await openList("Owed to us");
    expect(within(dialog).getAllByRole("button", { name: "Record return" }))
      .toHaveLength(2);
    expect(within(dialog).queryByRole("button", { name: "Close" }))
      .not.toBeInTheDocument();
  });
});

describe("SettlementsList — Checks on hand", () => {
  const hold: OpenSettlement = {
    id: 31, kind: "check_hold", report_date: addDaysIso(TODAY, -6),
    amount: 4000, note: "ABC Construction", settle_by: addDaysIso(TODAY, -1),
    settled: 2500, outstanding: 1500,
    returns: [{ id: 35, report_date: addDaysIso(TODAY, -2), amount: 2500 }],
  };
  const holdNoDate: OpenSettlement = {
    id: 32, kind: "check_hold", report_date: addDaysIso(TODAY, -1),
    amount: 700, note: "Lopez Roofing", settle_by: null,
    settled: 0, outstanding: 700, returns: [],
  };

  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    useOpenSettlements.mockReset();
    createLineItem.mockReset();
    updateLineItem.mockReset();
    useOpenSettlements.mockReturnValue({
      data: [lent, borrowed, hold, holdNoDate], isError: false,
    });
  });

  it("lists only held checks, with what went to the bank", () => {
    renderList();
    const list = screen.getByRole("table");
    expect(within(list).queryByText("Store #2 (Raj)")).not.toBeInTheDocument();
    expect(within(list).getByText("ABC Construction").closest("tr"))
      .toHaveTextContent("$2,500.00 on");
    expect(within(list).getByText("ABC Construction").closest("tr"))
      .toHaveTextContent("overdue");
  });

  it("keeps holds out of the Owed to us tile", () => {
    renderWidget("owed_to_us");
    expect(screen.getByRole("button", { name: /Owed to us/ }))
      .toHaveTextContent("$1,500.00");
  });

  it("deposits part of a hold as a linked no-cash entry on the viewed day", async () => {
    createLineItem.mockResolvedValue({});
    const { onChange } = renderList();
    const dialog = screen.getByRole("table");
    const tr = within(dialog).getByText("ABC Construction").closest("tr")!;
    await userEvent.click(within(tr).getByRole("button", { name: "Deposit" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    expect(form).toHaveTextContent("Check Deposits (from hold)");
    expect(form).toHaveTextContent("No effect on cash or over/short");
    const amount = within(form).getByLabelText(/Amount/);
    expect(amount).toHaveValue("1500");
    await userEvent.clear(amount);
    await userEvent.type(amount, "1000");
    await userEvent.click(within(form).getByRole("button", { name: "Deposit" }));
    await waitFor(() => expect(createLineItem).toHaveBeenCalledWith(1, VIEWED, {
      kind: "held_check_deposit", at_time: "", amount: 1000,
      note: "ABC Construction", settles_item_id: 31,
    }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it("refuses depositing more than is on hand without calling the server", async () => {
    const { container: dialog } = renderList();
    const tr = within(dialog).getByText("Lopez Roofing").closest("tr")!;
    await userEvent.click(within(tr).getByRole("button", { name: "Deposit" }));
    const form = screen.getAllByRole("dialog").at(-1)!;
    const amount = within(form).getByLabelText(/Amount/);
    await userEvent.clear(amount);
    await userEvent.type(amount, "701");
    await userEvent.click(within(form).getByRole("button", { name: "Deposit" }));
    expect(form).toHaveTextContent("Only $700.00 is still outstanding.");
    expect(createLineItem).not.toHaveBeenCalled();
  });

  it("offers no Deposit on a locked day but still Change date and Close", async () => {
    const { container: dialog } = renderList({ locked: true });
    expect(within(dialog).queryByRole("button", { name: "Deposit" }))
      .not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(2);
    expect(dialog).toHaveTextContent("record a deposit");
  });

  it("hides Deposit from someone who may only read the book", async () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["daily_book.read"],
    });
    const { container: dialog } = renderList();
    expect(within(dialog).getByText("Lopez Roofing")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Deposit" }))
      .not.toBeInTheDocument();
  });

  it("explains how to start when nothing is held", async () => {
    useOpenSettlements.mockReturnValue({ data: [lent], isError: false });
    const { container: dialog } = renderList();
    expect(dialog).toHaveTextContent("No checks on hand");
  });
});

describe("SettlementPill", () => {
  const base: LineItemRow = {
    id: 1, kind: "other_cash_out", at_time: "", amount: 2000, note: "",
    return_check_id: null, expects_settlement: false, settle_by: null,
    settled: 0, settles_item_id: null,
  };

  it("shows nothing on a plain entry", () => {
    const { container } = render(<SettlementPill item={base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows what is left on an open cash out", () => {
    render(<SettlementPill item={{ ...base, expects_settlement: true, settled: 500 }} />);
    expect(screen.getByText(/Expected back · \$1,500.00 left/)).toBeInTheDocument();
  });

  it("names borrowed money as owed", () => {
    render(<SettlementPill item={{
      ...base, kind: "other_cash_in", expects_settlement: true,
    }} />);
    expect(screen.getByText(/We owe · \$2,000.00 left/)).toBeInTheDocument();
  });

  it("marks a fully returned entry settled", () => {
    render(<SettlementPill item={{ ...base, expects_settlement: true, settled: 2000 }} />);
    expect(screen.getByText("Settled")).toBeInTheDocument();
  });

  it("marks a closed entry that got some back", () => {
    render(<SettlementPill item={{ ...base, settled: 500 }} />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("shows what is still on hand for a hold, then Deposited", () => {
    const { rerender } = render(<SettlementPill item={{
      ...base, kind: "check_hold", expects_settlement: true, settled: 2500,
      amount: 4000,
    }} />);
    expect(screen.getByText(/On hand · \$1,500.00 to deposit/)).toBeInTheDocument();
    rerender(<SettlementPill item={{
      ...base, kind: "check_hold", expects_settlement: true, settled: 4000,
      amount: 4000,
    }} />);
    expect(screen.getByText("Deposited")).toBeInTheDocument();
  });

  it("labels a held-check deposit entry", () => {
    render(<SettlementPill item={{
      ...base, kind: "held_check_deposit", settles_item_id: 31,
    }} />);
    expect(screen.getByText("Deposited")).toBeInTheDocument();
  });

  it("labels the return entry itself", () => {
    render(<SettlementPill item={{
      ...base, kind: "other_cash_in", settles_item_id: 7,
    }} />);
    expect(screen.getByText("Return")).toBeInTheDocument();
  });
});

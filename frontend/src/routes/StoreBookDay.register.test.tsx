import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoreBookDay from "./StoreBookDay";
import { ToastProvider } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// The register's day close on the store daily book:
//   - opening a day whose register figures the sheet has not taken
//     takes them, with no button to press (never on a locked day,
//     never for someone who cannot edit);
//   - the register's figure shows under its line, with a tick while
//     the box still holds it and a "not equal" mark plus "Use" once
//     somebody changed the box;
//   - a box is saved only when it was typed in, and an answer from
//     the server never wipes a box that is being typed in.

const DAY = "2026-09-14";

const fetchDay = vi.fn();
const pullStoreBookRegister = vi.fn();
const updateStoreBookDay = vi.fn();
const restoreStoreBookField = vi.fn();

// The real hook's cache key, fed by `fetchDay`, so what the page
// stores after a save / pull / restore is what it then renders.
vi.mock("../api/storebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/storebook")>()),
  useStoreBookDay: (day: string) => useQuery({
    queryKey: ["storebook", "day", 1, day],
    queryFn: () => fetchDay(day),
  }),
  pullStoreBookRegister: (...a: unknown[]) => pullStoreBookRegister(...a),
  updateStoreBookDay: (...a: unknown[]) => updateStoreBookDay(...a),
  restoreStoreBookField: (...a: unknown[]) => restoreStoreBookField(...a),
}));

vi.mock("../components/RegisterCloses", () => ({ default: () => null }));

const LAYOUT = [
  {
    column: "sales", label: "Sales",
    sections: [
      { key: "lottery", label: "Lottery", fields: [
        { key: "lottery_sales", label: "Lottery sales" },
        { key: "lotto_sales", label: "Lotto sales" },
      ] },
      { key: "money_order", label: "Money order", fields: [
        { key: "money_order", label: "Money order", count_field: "money_order_count" },
        { key: "money_order_fee", label: "Money order fee" },
      ] },
      { key: "check_fees", label: "Check fees", fields: [
        { key: "check_fees", label: "Check fees" },
      ] },
    ],
  },
  {
    column: "tenders", label: "Tenders",
    sections: [
      { key: "cards", label: "Cards", fields: [{ key: "cards", label: "Cards" }] },
    ],
  },
];

const REGISTER = {
  has_data: true, ready: true, pending: false, problem: "",
  period_start: "2026-09-15T04:59:45", period_end: "2026-09-16T04:59:18",
  received_at: "2026-09-16T05:01:00", unmapped: [], unplaced: [],
};

const ZERO = {
  lottery_sales: 0, lotto_sales: 0, money_order: 0, money_order_fee: 0,
  check_fees: 0, cards: 0,
};
// What the register reported, and the sheet once it has taken it.
const FROM_REGISTER = {
  lottery_sales: 30_000, lotto_sales: 8_000, money_order: 40_000,
  money_order_fee: 300, check_fees: 0, cards: 55_000,
};

function sheet(over: Record<string, unknown> = {}) {
  return {
    store_id: 1, entry_date: DAY, values: ZERO, counts: { money_order_count: 0 },
    originals: {}, notes: "", layout: LAYOUT, is_locked: false,
    locked_at: null, updated_at: null,
    totals: { sales_cents: 0, tenders_cents: 0, deposit_cents: 0, over_short_cents: 0 },
    register_day: REGISTER,
    ...over,
  };
}
const TAKEN = sheet({
  values: FROM_REGISTER, originals: FROM_REGISTER,
  counts: { money_order_count: 2 },
});
const PENDING = sheet({ register_day: { ...REGISTER, pending: true } });

const VIEWER = {
  ...TEST_ADMIN, role: "employee", permissions: ["day_close.read"],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/store-book/day?date=${DAY}`]}>
          <StoreBookDay />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchDay.mockReset();
  pullStoreBookRegister.mockReset();
  updateStoreBookDay.mockReset();
  restoreStoreBookField.mockReset();
});

describe("Store daily book: taking the register's day close", () => {
  it("takes the register's numbers as the day opens, with nothing to press", async () => {
    fetchDay.mockResolvedValue(PENDING);
    pullStoreBookRegister.mockResolvedValue(TAKEN);
    renderPage();
    expect(await screen.findByText("Register $300.00")).toBeInTheDocument();
    expect(pullStoreBookRegister).toHaveBeenCalledTimes(1);
    expect(pullStoreBookRegister).toHaveBeenCalledWith(DAY);
    expect(screen.getByLabelText("Lottery sales")).toHaveValue("300");
    expect(screen.getByLabelText("Money order count")).toHaveValue(2);
    // The page did it by itself: no toast about it.
    expect(screen.queryByText("Register numbers updated.")).not.toBeInTheDocument();
  });

  it("does not ask again when the sheet already has them", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    renderPage();
    await screen.findByText("Register $300.00");
    expect(pullStoreBookRegister).not.toHaveBeenCalled();
  });

  it("tries once and stays quiet when the server refuses", async () => {
    fetchDay.mockResolvedValue(PENDING);
    pullStoreBookRegister.mockRejectedValue(new Error("read only"));
    renderPage();
    await screen.findByText("Register day close");
    await waitFor(() => expect(pullStoreBookRegister).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Could not take the register's numbers.")).not.toBeInTheDocument();
    expect(pullStoreBookRegister).toHaveBeenCalledTimes(1);
  });

  it("leaves a locked day alone and says how to take them", async () => {
    fetchDay.mockResolvedValue(sheet({
      is_locked: true, locked_at: `${DAY}T20:00:00`,
      register_day: { ...REGISTER, pending: true },
    }));
    renderPage();
    expect(await screen.findByText(/Unlock the day to take them/)).toBeInTheDocument();
    expect(pullStoreBookRegister).not.toHaveBeenCalled();
  });

  it("leaves it to an editor when the person can only look", async () => {
    setCurrentIdentity(VIEWER);
    fetchDay.mockResolvedValue(PENDING);
    renderPage();
    expect(await screen.findByText(/someone who can edit the daily book opens it/))
      .toBeInTheDocument();
    expect(pullStoreBookRegister).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Lottery sales")).toBeDisabled();
  });

  it("takes them again from Refresh, and says so", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    pullStoreBookRegister.mockResolvedValue(TAKEN);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(pullStoreBookRegister).toHaveBeenCalledWith(DAY));
    expect(await screen.findByText("Register numbers updated.")).toBeInTheDocument();
  });

  it("shows nothing about the register for a store without the feed", async () => {
    fetchDay.mockResolvedValue(sheet({ register_day: null }));
    renderPage();
    await screen.findByLabelText("Lottery sales");
    expect(screen.queryByText("Register day close")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });
});

describe("Store daily book: the register's figure under a line", () => {
  it("marks a line that still holds the register's number", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    renderPage();
    const caption = (await screen.findByText("Register $300.00")).parentElement!;
    expect(within(caption).getByRole("img", { name: "Matches the register." }))
      .toBeInTheDocument();
    expect(within(caption).queryByRole("button")).not.toBeInTheDocument();
    // Read out with the box it belongs to.
    expect(screen.getByLabelText("Lottery sales"))
      .toHaveAttribute("aria-describedby", caption.id);
    expect(screen.getByText("Matches the register")).toBeInTheDocument();
  });

  it("marks a changed line and counts it, as soon as it is typed", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    const user = userEvent.setup();
    renderPage();
    const box = await screen.findByLabelText("Lottery sales");
    await user.clear(box);
    await user.type(box, "310");
    const caption = screen.getByText("Register $300.00").parentElement!;
    expect(within(caption).getByRole("img", { name: "Different from the register." }))
      .toBeInTheDocument();
    expect(screen.getByText("1 changed by hand")).toBeInTheDocument();
  });

  it("takes the register's number back with Use", async () => {
    fetchDay.mockResolvedValue(sheet({
      values: { ...FROM_REGISTER, lottery_sales: 31_000 },
      originals: FROM_REGISTER,
    }));
    restoreStoreBookField.mockResolvedValue(TAKEN);
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Use: Register $300.00" }),
    );
    await waitFor(() =>
      expect(restoreStoreBookField).toHaveBeenCalledWith(DAY, "lottery_sales"));
    await waitFor(() =>
      expect(screen.getByLabelText("Lottery sales")).toHaveValue("300"));
    expect(screen.queryByRole("button", { name: /^Use/ })).not.toBeInTheDocument();
  });

  it("keeps a $0.00 line quiet until somebody puts a number on it", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    const user = userEvent.setup();
    renderPage();
    const box = await screen.findByLabelText("Check fees");
    expect(screen.queryByText("Register $0.00")).not.toBeInTheDocument();
    await user.type(box, "9");
    expect(screen.getByText("Register $0.00")).toBeInTheDocument();
  });

  it("drops a group's heading when it would only repeat its one line", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    renderPage();
    await screen.findByLabelText("Check fees");
    // "Check fees" is the line's name; the group has no second copy.
    expect(screen.getAllByText("Check fees")).toHaveLength(1);
    // "Money order" holds two lines, so it keeps its heading, and
    // the heading names the group.
    expect(screen.getAllByText("Money order")).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Money order" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Check fees" })).not.toBeInTheDocument();
  });
});

describe("Store daily book: what the register could not place", () => {
  it("lists a payment type that sits on no line", async () => {
    fetchDay.mockResolvedValue(sheet({
      values: FROM_REGISTER, originals: FROM_REGISTER,
      register_day: {
        ...REGISTER,
        unplaced: [{ kind: "payment_type", code: "8", name: "", amount_cents: 732 }],
      },
    }));
    renderPage();
    expect(await screen.findByText("On no line:")).toBeInTheDocument();
    expect(screen.getByText("Payment type 8")).toBeInTheDocument();
    expect(screen.getByText("$7.32")).toBeInTheDocument();
  });

  it("names the departments to set up when the day could not be filled", async () => {
    fetchDay.mockResolvedValue(sheet({
      register_day: {
        ...REGISTER, ready: false, problem: "departments",
        unmapped: [{
          kind: "department", code: "3", name: "Lottery Paid In",
          amount_cents: 30_000,
        }],
      },
    }));
    renderPage();
    expect(await screen.findByText(/departments that are not set up yet/))
      .toBeInTheDocument();
    expect(screen.getByText("3 · Lottery Paid In")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up departments" }))
      .toHaveAttribute("href", "/account/departments");
    expect(pullStoreBookRegister).not.toHaveBeenCalled();
  });

  it("says so when the register has sent nothing for the day", async () => {
    fetchDay.mockResolvedValue(sheet({
      register_day: {
        ...REGISTER, has_data: false, ready: false,
        period_start: null, period_end: null, received_at: null,
      },
    }));
    renderPage();
    expect(await screen.findByText(/No day close from the register/))
      .toBeInTheDocument();
  });
});

describe("Store daily book: saving a line", () => {
  it("saves a box only when it was typed in", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    updateStoreBookDay.mockResolvedValue(sheet({
      values: { ...FROM_REGISTER, cards: 56_000 }, originals: FROM_REGISTER,
    }));
    const user = userEvent.setup();
    renderPage();
    const lottery = await screen.findByLabelText("Lottery sales");
    // Tabbing through boxes changes nothing and saves nothing.
    await user.click(lottery);
    await user.tab();
    await user.tab();
    expect(updateStoreBookDay).not.toHaveBeenCalled();

    const cards = screen.getByLabelText("Cards");
    await user.clear(cards);
    await user.type(cards, "560");
    await user.tab();
    await waitFor(() => expect(updateStoreBookDay).toHaveBeenCalledTimes(1));
    expect(updateStoreBookDay).toHaveBeenCalledWith(DAY, { values: { cards: 56_000 } });
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
  });

  it("saves the count with its money box, once, on leaving the line", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    updateStoreBookDay.mockResolvedValue(TAKEN);
    const user = userEvent.setup();
    renderPage();
    const count = await screen.findByLabelText("Money order count");
    await user.clear(count);
    await user.type(count, "3");
    // Count box → money box of the same line: not leaving the line.
    await user.tab();
    expect(updateStoreBookDay).not.toHaveBeenCalled();
    await user.tab();
    await waitFor(() => expect(updateStoreBookDay).toHaveBeenCalledTimes(1));
    expect(updateStoreBookDay).toHaveBeenCalledWith(DAY, {
      values: { money_order: 40_000 }, counts: { money_order_count: 3 },
    });
  });

  it("does not wipe a box being typed in when another box's save answers", async () => {
    fetchDay.mockResolvedValue(TAKEN);
    let answer: (v: unknown) => void = () => {};
    updateStoreBookDay.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    renderPage();
    const lottery = await screen.findByLabelText("Lottery sales");
    await user.clear(lottery);
    await user.type(lottery, "310");
    // On to the next box while the save is still on its way…
    const lotto = screen.getByLabelText("Lotto sales");
    await user.click(lotto);
    await user.clear(lotto);
    await user.type(lotto, "95");
    // …and the save answers with what the server had: Lotto $80.00.
    answer(sheet({
      values: { ...FROM_REGISTER, lottery_sales: 31_000 },
      originals: FROM_REGISTER,
    }));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
    expect(lotto).toHaveValue("95");
    expect(lottery).toHaveValue("310");
  });
});

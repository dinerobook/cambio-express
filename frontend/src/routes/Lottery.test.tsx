import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Lottery from "./Lottery";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Lottery is cash: a closing count decides tickets sold and the
// lottery money in the drawer. Pinned here:
//   - Day close: a count saves only when it is a whole number that
//     changed, and goes to the server as a number for that day.
//   - An uncounted pack is flagged in the KPI strip.
//   - Add game: the ticket price is a MoneyInput, so "$2.50" typed
//     reaches the API as 2.5.
//   - Without lottery.create the Save control is not shown.

const recordLotteryCount = vi.fn();
const createLotteryGame = vi.fn();
const settleLotteryPack = vi.fn();
const returnLotteryPack = vi.fn();
const updateLotteryGame = vi.fn();
const useLotteryDay = vi.fn();
const useLotteryPacks = vi.fn();
const useLotteryGames = vi.fn();

const daySummary = {
  date: "2026-10-07",
  total_sold: 12,
  total_value: 60,
  uncounted_active_packs: 1,
  rows: [
    {
      pack_id: 5, bin_number: "3", game_number: "2417", game_name: "Lucky 7s",
      pack_number: "0012345", ticket_price: 5, previous_reference: 10,
      closing_ticket: 22, counted: true, sold: 12, value: 60,
    },
    {
      pack_id: 6, bin_number: "4", game_number: "2500", game_name: "Cash Blast",
      pack_number: "0099999", ticket_price: 2, previous_reference: 0,
      closing_ticket: null, counted: false, sold: 0, value: 0,
    },
  ],
};

vi.mock("../api/lottery", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/lottery")>();
  return {
    ...real,
    recordLotteryCount: (...a: unknown[]) => recordLotteryCount(...a),
    createLotteryGame: (...a: unknown[]) => createLotteryGame(...a),
    settleLotteryPack: (...a: unknown[]) => settleLotteryPack(...a),
    returnLotteryPack: (...a: unknown[]) => returnLotteryPack(...a),
    updateLotteryGame: (...a: unknown[]) => updateLotteryGame(...a),
    useLotteryDay: (day: string) => useLotteryDay(day),
    useLotteryGames: () => useLotteryGames(),
    useLotteryPacks: () => useLotteryPacks(),
  };
});

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, refetch: vi.fn(),
});
// Stable per-day objects: a new object per render would look like a
// refetch.
const DAY_CACHE = new Map<string, unknown>();

beforeEach(() => {
  DAY_CACHE.clear();
  useLotteryDay.mockReset().mockImplementation((day: string) => {
    if (!DAY_CACHE.has(day)) DAY_CACHE.set(day, ok({ ...daySummary, date: day }));
    return DAY_CACHE.get(day);
  });
  useLotteryGames.mockReset().mockReturnValue(ok({ games: [] }));
  useLotteryPacks.mockReset().mockReturnValue(ok({ packs: [] }));
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <Lottery />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("Lottery day close", () => {
  beforeEach(() => {
    recordLotteryCount.mockReset();
    recordLotteryCount.mockResolvedValue({});
  });

  it("shows the day's totals and flags the uncounted pack", () => {
    renderPage();
    expect(screen.getByText("Lottery total").parentElement).toHaveTextContent("$60.00");
    expect(screen.getByText("Tickets sold").parentElement).toHaveTextContent("12");
    expect(screen.getByText("Uncounted packs").parentElement).toHaveTextContent("1");
    // The uncounted pack's row is shown with an empty count box.
    expect(screen.getByLabelText("Closing count for pack 0099999")).toHaveValue(null);
  });

  it("enables Save only for a changed whole-number count", async () => {
    renderPage();
    const input = screen.getByLabelText("Closing count for pack 0012345");
    const save = within(input.closest("tr")!).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();              // unchanged
    await userEvent.clear(input);
    await userEvent.type(input, "-3");
    expect(save).toBeDisabled();              // negative
    await userEvent.clear(input);
    await userEvent.type(input, "25");
    expect(save).toBeEnabled();
  });

  it("saves the count as a number for the chosen day", async () => {
    renderPage();
    const input = screen.getByLabelText("Closing count for pack 0099999");
    await userEvent.type(input, "7");
    await userEvent.click(within(input.closest("tr")!).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(recordLotteryCount).toHaveBeenCalledTimes(1));
    const [day, body] = recordLotteryCount.mock.calls[0];
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body).toEqual({ pack_id: 6, closing_ticket: 7 });
    expect(await screen.findByText("Count saved.")).toBeInTheDocument();
  });

  it("shows the server's reason when a count is refused", async () => {
    recordLotteryCount.mockRejectedValue(
      new ApiError(409, "That day is locked.", null),
    );
    renderPage();
    const input = screen.getByLabelText("Closing count for pack 0099999");
    await userEvent.type(input, "7");
    await userEvent.click(within(input.closest("tr")!).getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That day is locked.");
  });

  it("hides Save from someone who cannot record counts", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["lottery.read"],
    });
    renderPage();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});

describe("Lottery add game", () => {
  beforeEach(() => {
    createLotteryGame.mockReset();
    createLotteryGame.mockResolvedValue({});
  });

  it("sends the ticket price as dollars", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Games" }));
    await userEvent.click(screen.getByRole("button", { name: "+ Add game" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/State game #/), "2417");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Lucky 7s");
    await userEvent.type(within(dialog).getByLabelText(/^Ticket price/), "2.50");
    await userEvent.type(within(dialog).getByLabelText(/Tickets per pack/), "100");
    await userEvent.click(within(dialog).getByRole("button", { name: /save|add/i }));
    await waitFor(() => expect(createLotteryGame).toHaveBeenCalledWith({
      game_number: "2417", name: "Lucky 7s",
      ticket_price: 2.5, tickets_per_pack: 100,
    }));
  });
});

describe("Lottery day close — date switch", () => {
  it("does not carry a typed count over to another day", async () => {
    renderPage();
    const input = screen.getByLabelText("Closing count for pack 0012345");
    await userEvent.clear(input);
    await userEvent.type(input, "30");
    // The next day: the same pack, not counted yet.
    DAY_CACHE.set("2026-10-08", ok({
      ...daySummary, date: "2026-10-08",
      rows: daySummary.rows.map((r) => ({
        ...r, closing_ticket: null, counted: false, previous_reference: 22,
      })),
    }));
    fireEvent.change(screen.getByLabelText("Count date"), {
      target: { value: "2026-10-08" },
    });
    await waitFor(() =>
      expect(useLotteryDay).toHaveBeenLastCalledWith("2026-10-08"));
    expect(screen.getByLabelText("Closing count for pack 0012345"))
      .toHaveValue(null);
  });
});

const PACK = {
  id: 9, game_id: 1, game_number: "2417", game_name: "Lucky 7s",
  pack_number: "0012345", status: "active", bin_number: "3",
  opening_ticket: 0, received_on: "2026-10-01", activated_on: "2026-10-02",
};

describe("Lottery packs — settle / return ask first", () => {
  beforeEach(() => {
    settleLotteryPack.mockReset().mockResolvedValue({});
    returnLotteryPack.mockReset().mockResolvedValue({});
    useLotteryPacks.mockReturnValue(ok({ packs: [PACK] }));
  });

  it.each([
    ["Settle", () => settleLotteryPack, "Settle"],
    ["Return to state", () => returnLotteryPack, "Return to state"],
  ])("%s confirms in a dialog; Cancel sends nothing", async (label, fn, confirm) => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Packs" }));
    const row = screen.getByText("0012345").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: label }));
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fn()).not.toHaveBeenCalled();

    await userEvent.click(within(row).getByRole("button", { name: label }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: confirm }));
    await waitFor(() => expect(fn()).toHaveBeenCalledWith(9, expect.any(String)));
  });

  it("shows a refusal inside the dialog", async () => {
    settleLotteryPack.mockRejectedValue(new ApiError(409, "Pack has uncounted days.", null));
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Packs" }));
    const row = screen.getByText("0012345").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Settle" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Settle" }));
    expect(await within(dialog).findByText("Pack has uncounted days.")).toBeInTheDocument();
  });
});

describe("Lottery games — lottery.update gates the controls", () => {
  const GAME = {
    id: 1, game_number: "2417", name: "Lucky 7s", ticket_price: 5,
    tickets_per_pack: 100, is_active: true,
  };
  beforeEach(() => {
    useLotteryGames.mockReturnValue(ok({ games: [GAME] }));
  });

  it("shows Add game and Deactivate to someone with lottery.update", async () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Games" }));
    expect(screen.getByRole("button", { name: "+ Add game" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeInTheDocument();
  });

  it("hides them from someone who can only view lottery", async () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["lottery.read", "lottery.create"],
    });
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Games" }));
    expect(screen.queryByRole("button", { name: "+ Add game" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Deactivate" })).not.toBeInTheDocument();
  });
});

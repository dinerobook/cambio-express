import { render, screen, waitFor, within } from "@testing-library/react";
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
    useLotteryDay: () => ({
      data: daySummary, isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useLotteryGames: () => ({
      data: { games: [] }, isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useLotteryPacks: () => ({
      data: { packs: [] }, isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
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

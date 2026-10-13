import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Bank from "./Bank";
import ItemMovement from "./ItemMovement";
import Transactions from "./Transactions";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Finance → Bank accounts (connect / refresh / rename / disconnect)
// and the two register-journal read pages (Transactions, Item
// movement). Pinned: data renders, each write succeeds with a toast
// or shows the server's refusal, and a failed load offers a retry.

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.Stripe;
});

function failThenServe(body: unknown) {
  const state = { fail: true };
  const handler: MockHandler = () => (state.fail
    ? { status: 500, body: { detail: "Database unavailable." } }
    : { body });
  return { state, handler };
}

const ACCOUNT = {
  id: 4, institution_name: "Nizari Progressive", display_name: "Checking", nickname: "",
  last4: "0230", label: "Nizari ••0230", category: "checking", subcategory: "",
  currency: "usd", last_balance_cents: 1234567, last_balance: 12345.67,
  last_balance_as_of: "2026-10-09T15:00:00", enabled: true, connected_at: "", disconnected_at: "",
};

describe("Bank accounts", () => {
  function routes(extra: Record<string, MockHandler> = {}) {
    return { "GET /api/v2/bank/accounts": { body: { rows: [ACCOUNT], total: 1 } }, ...extra };
  }

  it("shows each connected account with its balance", async () => {
    mockFetch(routes());
    renderRoute(<Bank />);
    expect(await screen.findByText("Nizari ••0230")).toBeInTheDocument();
    expect(screen.getByText("$12,345.67")).toBeInTheDocument();
    expect(screen.getByText("1 of 6")).toBeInTheDocument();
  });

  it("invites a first connection when there are none", async () => {
    mockFetch(routes({ "GET /api/v2/bank/accounts": { body: { rows: [], total: 0 } } }));
    renderRoute(<Bank />);
    expect(await screen.findByRole("button", { name: "Connect bank via Stripe →" })).toBeInTheDocument();
  });

  it("connects through Stripe and reports what was linked", async () => {
    const collect = vi.fn().mockResolvedValue({});
    window.Stripe = () => ({ collectFinancialConnectionsAccounts: collect });
    const calls = mockFetch(routes({
      "GET /api/v2/bank/accounts": { body: { rows: [], total: 0 } },
      "POST /api/v2/bank/connect": {
        body: { clientSecret: "fcsess_secret", sessionId: "fcsess_1", publishableKey: "pk_test" },
      },
      "POST /api/v2/bank/connect/complete": { body: { accounts_added: 2, accounts_total: 2 } },
    }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect bank via Stripe →" }));
    expect(await screen.findByText("Linked 2 account(s).")).toBeInTheDocument();
    expect(collect).toHaveBeenCalledWith({ clientSecret: "fcsess_secret" });
    expect(callsTo(calls, "POST /api/v2/bank/connect/complete")[0].body).toEqual({ sessionId: "fcsess_1" });
  });

  it("shows a cancelled Stripe flow and saves nothing", async () => {
    window.Stripe = () => ({
      collectFinancialConnectionsAccounts: async () => ({ error: { message: "User closed the window." } }),
    });
    const calls = mockFetch(routes({
      "GET /api/v2/bank/accounts": { body: { rows: [], total: 0 } },
      "POST /api/v2/bank/connect": {
        body: { clientSecret: "s", sessionId: "fcsess_1", publishableKey: "pk_test" },
      },
    }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect bank via Stripe →" }));
    expect(await screen.findByText("User closed the window.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/bank/connect/complete")).toHaveLength(0);
  });

  it("shows the server's refusal to start a connection (cap reached)", async () => {
    window.Stripe = () => ({ collectFinancialConnectionsAccounts: vi.fn() });
    mockFetch(routes({
      "POST /api/v2/bank/connect": { status: 409, body: { detail: "This store already has 6 bank accounts." } },
    }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "+ Connect another" }));
    expect(await screen.findByText("This store already has 6 bank accounts.")).toBeInTheDocument();
  });

  it("refreshes balances, surfacing a Stripe warning", async () => {
    mockFetch(routes({
      "POST /api/v2/bank/refresh": { body: { accounts_refreshed: 1, error: "rate limited" } },
    }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Refreshed (1). Warning: rate limited")).toBeInTheDocument();
  });

  it("renames an account", async () => {
    const calls = mockFetch(routes({
      "PUT /api/v2/bank/accounts/4/nickname": { body: { ...ACCOUNT, nickname: "MSB Checking" } },
    }));
    renderRoute(<Bank />);
    await userEvent.type(await screen.findByPlaceholderText(/Set nickname/), "MSB Checking");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText('Renamed to "MSB Checking".')).toBeInTheDocument();
    expect(callsTo(calls, "PUT /api/v2/bank/accounts/4/nickname")[0].body)
      .toEqual({ nickname: "MSB Checking" });
  });

  it("disconnects after confirming", async () => {
    const calls = mockFetch(routes({ "POST /api/v2/bank/disconnect/4": { status: 204 } }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Disconnect Nizari ••0230\?/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected Nizari ••0230.")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/bank/disconnect/4")).toHaveLength(1);
  });

  it("shows a refused disconnect", async () => {
    mockFetch(routes({
      "POST /api/v2/bank/disconnect/4": { status: 403, body: { detail: "Admins only." } },
    }));
    renderRoute(<Bank />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Admins only.")).toBeInTheDocument();
  });

  it("shows a bank_sync.read-only viewer the balances but no controls", async () => {
    signInAs({ without: ["bank_sync.update"] });
    mockFetch(routes());
    renderRoute(<Bank />);
    expect(await screen.findByText("$12,345.67")).toBeInTheDocument();
    for (const name of ["Refresh", "+ Connect another", "Save", "Disconnect"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByPlaceholderText(/Set nickname/)).not.toBeInTheDocument();
  });

  it("offers a read-only viewer no connect button when nothing is linked", async () => {
    signInAs({ without: ["bank_sync.update"] });
    mockFetch(routes({ "GET /api/v2/bank/accounts": { body: { rows: [], total: 0 } } }));
    renderRoute(<Bank />);
    expect(await screen.findByText("Connect your bank")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect bank via Stripe/ })).not.toBeInTheDocument();
  });

  it("offers a retry when the accounts fail to load", async () => {
    const { state, handler } = failThenServe({ rows: [ACCOUNT], total: 1 });
    mockFetch(routes({ "GET /api/v2/bank/accounts": handler }));
    renderRoute(<Bank />);
    expect(await screen.findByText("Couldn't load accounts.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Nizari ••0230")).toBeInTheDocument();
  });
});

describe("Transactions (register journal)", () => {
  const LIST = {
    rows: [{
      id: 77, transaction_no: "T-1001", business_date: "2026-10-09", receipt_at: "2026-10-09T15:00:00",
      register_id: "R1", cashier_id: "C9", item_count: 3, tax: 0.82, grand_total: 12.5,
      kind: "refund", has_voided_line: true, training_mode: false, offline: false, suspended: false,
    }],
    total: 1, page: 1, total_pages: 1, total_grand: 12.5, voided_count: 1,
  };

  it("lists tickets with their flags and links", async () => {
    mockFetch({ "GET /api/v2/posimport/transactions": { body: LIST } });
    renderRoute(<Transactions />, { path: "/transactions" });
    expect(await screen.findByRole("link", { name: "T-1001" })).toBeInTheDocument();
    expect(screen.getByText("voided item")).toBeInTheDocument();
    expect(screen.getByText("refund")).toBeInTheDocument();
    expect(screen.getAllByText("$12.50").length).toBeGreaterThan(0);
  });

  it("asks the server for voided tickets only when ticked", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/transactions": { body: LIST } });
    renderRoute(<Transactions />, { path: "/transactions" });
    await screen.findByRole("link", { name: "T-1001" });
    await userEvent.click(screen.getByRole("checkbox", { name: "Voided items only" }));
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("voided_only") === "true"),
    ).toBe(true));
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/posimport/transactions": { body: { ...LIST, rows: [], total: 0 } } });
    renderRoute(<Transactions />, { path: "/transactions" });
    expect(await screen.findByText("No transactions in this range")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(LIST);
    mockFetch({ "GET /api/v2/posimport/transactions": handler });
    renderRoute(<Transactions />, { path: "/transactions" });
    expect(await screen.findByText("Could not load transactions.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "T-1001" })).toBeInTheDocument();
  });
});

describe("Item movement", () => {
  const MOVE = {
    start: "2026-10-03", end: "2026-10-09",
    rows: [{ pos_code: "0001234", description: "Coca-Cola 20oz", quantity: 40,
      amount: 99.6, avg_price: 2.49, in_price_book: false }],
    total: 1, total_quantity: 40, total_amount: 99.6, page: 1, total_pages: 1,
  };

  it("lists items with totals and flags ones missing from the price book", async () => {
    mockFetch({ "GET /api/v2/posimport/item-movement": { body: MOVE } });
    renderRoute(<ItemMovement />);
    expect(await screen.findByText("Coca-Cola 20oz")).toBeInTheDocument();
    expect(screen.getByText("not in price book")).toBeInTheDocument();
    expect(screen.getByText("$2.49")).toBeInTheDocument();
    expect(screen.getAllByText("$99.60").length).toBeGreaterThan(0);
  });

  it("searches as you type", async () => {
    const calls = mockFetch({ "GET /api/v2/posimport/item-movement": { body: MOVE } });
    renderRoute(<ItemMovement />);
    await screen.findByText("Coca-Cola 20oz");
    await userEvent.type(screen.getByPlaceholderText(/Description or scan code/), "coke");
    await vi.waitFor(() => expect(
      calls.some((c) => c.url.searchParams.get("q") === "coke"),
    ).toBe(true), { timeout: 2000 });
  });

  it("shows the empty state", async () => {
    mockFetch({ "GET /api/v2/posimport/item-movement": { body: { ...MOVE, rows: [], total: 0 } } });
    renderRoute(<ItemMovement />);
    expect(await screen.findByText("No movement in this range")).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    const { state, handler } = failThenServe(MOVE);
    mockFetch({ "GET /api/v2/posimport/item-movement": handler });
    renderRoute(<ItemMovement />);
    expect(await screen.findByText("Could not load item movement.")).toBeInTheDocument();
    state.fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Coca-Cola 20oz")).toBeInTheDocument();
  });
});

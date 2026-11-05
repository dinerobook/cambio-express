import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "./AppShell";
import SwitchStoreModal from "./SwitchStoreModal";
import { ToastProvider } from "./ui/Toast";
import { setLanguage } from "../i18n";
import { getCurrentIdentity, getRefreshFallback, setCurrentIdentity } from "../lib/auth";
import { callsTo, mockFetch } from "../test/fetchMock";
import { englishLeftovers } from "../test/i18n";
import { TEST_ADMIN } from "../test/setup";

// The Switch Store popup, for owners and — since linked logins —
// accountants (Auth INVARIANTS "Linked accountant logins"). The
// server decides which stores a sign-in may switch to and refuses
// the rest (tests/Modules/Auth/test_accountant_store_switch.py);
// these pin the SPA side: an accountant sees the chip only with two
// or more linked stores, gets no owner controls, lands on Reports,
// and a refused switch leaves them where they were with the reason.

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useProfile: () => ({ data: undefined }),
    useSessionStatus: () => ({ data: { store_name: "Alpha Books" } }),
    useStoreInfo: () => ({ data: undefined }),
  };
});
vi.mock("../api/support", () => ({
  useTicketsUnread: () => ({ data: { unread: 0 } }),
}));

const ACCOUNTANT = {
  ...TEST_ADMIN,
  user_id: 41, role: "accountant", store_id: 1,
  permissions: ["monthly.read", "reports.read"],
};

const ALPHA = {
  store_id: 1, name: "Alpha Books", slug: "alpha", address: "1 Main St",
  is_current: true, is_home: false,
};
const BETA = {
  store_id: 2, name: "Beta Books", slug: "beta", address: "2 Oak Ave",
  is_current: false, is_home: false,
};

const SWITCHED_TO_BETA = {
  access_token: "t", store_id: 2, store_name: "Beta Books",
  role: "accountant", expires_in: 1800, user_id: 42,
  username: "cpa@x.example", full_name: "Pat Ledger",
  permissions: ["monthly.read", "reports.read"],
  owner_id: null, refresh_jti: "beta-row",
};

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}</p>;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderShell() {
  return render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/reports"]}>
        <ToastProvider>
          <AppShell><p>page</p></AppShell>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderModal() {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/reports"]}>
        <ToastProvider>
          <Routes>
            <Route path="*" element={
              <>
                <SwitchStoreModal open onClose={onClose} />
                <Where />
              </>
            } />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  // jsdom has no matchMedia; the install button asks it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as never;
});

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    window.localStorage.removeItem("db.owner_active_store");
    window.localStorage.removeItem("db.refresh_fallback");
  } catch { /* */ }
});

describe("accountant store chip", () => {
  it("shows the current store once the sign-in is linked to two stores", async () => {
    setCurrentIdentity(ACCOUNTANT);
    const calls = mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
      "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
      "GET /api/v2/*": { body: {} },
    });
    renderShell();
    const chip = await screen.findByRole("button", { name: /Alpha Books/ });
    expect(chip).toHaveAttribute("title", "Switch store");
    expect(callsTo(calls, "GET /api/v2/auth/my-stores")).toHaveLength(1);
  });

  it("stays hidden for a one-store accountant", async () => {
    setCurrentIdentity(ACCOUNTANT);
    const calls = mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA] } },
      "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
      "GET /api/v2/*": { body: {} },
    });
    renderShell();
    await waitFor(() =>
      expect(callsTo(calls, "GET /api/v2/auth/my-stores")).toHaveLength(1));
    expect(screen.queryByTitle("Switch store")).not.toBeInTheDocument();
  });

  it("stays hidden when the store list cannot load", async () => {
    setCurrentIdentity(ACCOUNTANT);
    mockFetch({
      "GET /api/v2/auth/my-stores": { status: 500, body: { detail: "boom" } },
      "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
      "GET /api/v2/*": { body: {} },
    });
    renderShell();
    await screen.findByText("page");
    expect(screen.queryByTitle("Switch store")).not.toBeInTheDocument();
  });

  it("never asks a store admin's session for stores", async () => {
    // TEST_ADMIN is signed in by default: no owner, no accountant.
    const calls = mockFetch({
      "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
      "GET /api/v2/*": { body: {} },
    });
    renderShell();
    await screen.findByText("page");
    expect(callsTo(calls, "GET /api/v2/auth/my-stores")).toHaveLength(0);
    expect(screen.queryByTitle("Switch store")).not.toBeInTheDocument();
  });
});

describe("accountant switch popup", () => {
  it("switches to the other store and lands on Reports", async () => {
    setCurrentIdentity(ACCOUNTANT);
    const calls = mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
      "POST /api/v2/auth/switch-store": { body: SWITCHED_TO_BETA },
    });
    const onClose = renderModal();
    await screen.findByText("Beta Books");
    // No owner controls for an accountant.
    expect(screen.queryByRole("button", { name: "Add a new store" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Owner overview/ })).not.toBeInTheDocument();
    // The current store cannot be picked again.
    expect(screen.getByRole("button", { name: /^Alpha Books/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /^Beta Books/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(callsTo(calls, "POST /api/v2/auth/switch-store")[0].body)
      .toEqual({ store_id: 2 });
    expect(screen.getByTestId("where")).toHaveTextContent("/reports");
    // The identity is the store-B login now…
    expect(getCurrentIdentity()).toMatchObject({
      user_id: 42, store_id: 2, role: "accountant", owner_id: null,
    });
    // …the PWA fallback follows the session's new refresh row, and
    // nothing is remembered for an owner-style re-entry.
    expect(getRefreshFallback()).toBe("beta-row");
    expect(window.localStorage.getItem("db.owner_active_store")).toBeNull();
  });

  it("shows why when the server refuses the switch", async () => {
    setCurrentIdentity(ACCOUNTANT);
    mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
      "POST /api/v2/auth/switch-store": { status: 404, body: { detail: "Store not found" } },
    });
    const onClose = renderModal();
    await userEvent.click(await screen.findByRole("button", { name: /^Beta Books/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Store not found");
    expect(onClose).not.toHaveBeenCalled();
    expect(getCurrentIdentity()).toMatchObject({ user_id: 41, store_id: 1 });
    // Still able to pick again: nothing is left busy.
    expect(screen.getByRole("button", { name: /^Beta Books/ })).toBeEnabled();
  });

  it("offers a retry when the store list cannot load", async () => {
    setCurrentIdentity(ACCOUNTANT);
    mockFetch({
      "GET /api/v2/auth/my-stores": { status: 500, body: { detail: "boom" } },
    });
    renderModal();
    expect(await screen.findByText("Could not load your stores.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    setCurrentIdentity(ACCOUNTANT);
    mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
    });
    renderModal();
    await screen.findByText("Beta Books");
    expect(screen.getByText("actual")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Buscar tiendas por nombre o dirección…"))
      .toBeInTheDocument();
    expect(englishLeftovers(document.body, ["switchStore.", "shell.switchStore"]))
      .toEqual([]);
  });
});

describe("owner switch popup (unchanged)", () => {
  const OWNER_IN_STORE = { ...TEST_ADMIN, user_id: 7, role: "admin", owner_id: 7 };

  it("keeps the owner controls and remembers the store for refresh", async () => {
    setCurrentIdentity(OWNER_IN_STORE);
    mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [
        { ...ALPHA, is_home: true }, BETA,
      ] } },
      "POST /api/v2/auth/switch-store": { body: {
        ...SWITCHED_TO_BETA, role: "admin", user_id: 7, owner_id: 7,
        refresh_jti: null,
      } },
    });
    renderModal();
    await screen.findByText("Beta Books");
    expect(screen.getByRole("button", { name: "Add a new store" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Owner overview/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Beta Books/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where")).toHaveTextContent("/dashboard"));
    expect(window.localStorage.getItem("db.owner_active_store")).toBe("2");
    expect(getCurrentIdentity()).toMatchObject({ owner_id: 7, store_id: 2 });
  });

  it("lists the stores with a star and the current marker", async () => {
    setCurrentIdentity(OWNER_IN_STORE);
    mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
    });
    renderModal();
    const row = (await screen.findByText("Alpha Books")).closest("div")!;
    expect(within(row.parentElement!).getByText("current")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Favorite Beta Books" })).toBeInTheDocument();
  });
});

describe("owner switch popup: search, favourites, add a store", () => {
  const OWNER_IN_STORE = { ...TEST_ADMIN, user_id: 7, role: "admin", owner_id: 7 };
  const SEARCH = "Search stores by name or address…";

  it("searches by name or address and says when nothing matches", async () => {
    setCurrentIdentity(OWNER_IN_STORE);
    mockFetch({ "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } } });
    renderModal();
    await screen.findByText("Beta Books");
    await userEvent.type(screen.getByPlaceholderText(SEARCH), "oak");
    expect(screen.queryByText("Alpha Books")).toBeNull();
    expect(screen.getByText("Beta Books")).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText(SEARCH));
    await userEvent.type(screen.getByPlaceholderText(SEARCH), "zzz");
    expect(screen.getByText("No stores match")).toBeInTheDocument();
  });

  it("the favourites tab is empty until a store is starred", async () => {
    window.localStorage.removeItem("db.store_favorites");
    setCurrentIdentity(OWNER_IN_STORE);
    mockFetch({ "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } } });
    renderModal();
    await screen.findByText("Beta Books");
    await userEvent.click(screen.getByRole("button", { name: "★ Favorites (0)" }));
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "All stores (2)" }));
    await userEvent.click(screen.getByRole("button", { name: "Favorite Beta Books" }));
    expect(screen.getByRole("button", { name: "Unfavorite Beta Books" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "★ Favorites (1)" })).toBeInTheDocument();
    window.localStorage.removeItem("db.store_favorites");
  });

  it("adds a store with the picked business type", async () => {
    setCurrentIdentity(OWNER_IN_STORE);
    const calls = mockFetch({
      "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } },
      "POST /api/v2/auth/my-stores": { body: { ...BETA, store_id: 3, name: "Gamma" } },
    });
    renderModal();
    await screen.findByText("Beta Books");
    await userEvent.click(screen.getByRole("button", { name: "Add a new store" }));
    const create = screen.getByRole("button", { name: "Create & enter →" });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Store name"), "Gamma");
    await userEvent.selectOptions(screen.getByRole("combobox"), "gas_station");
    await userEvent.click(create);
    await waitFor(() => expect(callsTo(calls, "POST /api/v2/auth/my-stores")).toHaveLength(1));
    expect(callsTo(calls, "POST /api/v2/auth/my-stores")[0].body)
      .toEqual({ name: "Gamma", business_type: "gas_station" });
  });

  it("the add-store form reads in Spanish", async () => {
    setLanguage("es");
    setCurrentIdentity(OWNER_IN_STORE);
    mockFetch({ "GET /api/v2/auth/my-stores": { body: { stores: [ALPHA, BETA] } } });
    renderModal();
    await screen.findByText("Beta Books");
    await userEvent.click(screen.getByRole("button", { name: "Agregar una tienda nueva" }));
    expect(screen.getByRole("option", { name: "Gasolinera" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["switchStore."])).toEqual([]);
  });
});

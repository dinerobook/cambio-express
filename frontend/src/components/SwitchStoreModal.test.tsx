import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import SwitchStoreModal from "./SwitchStoreModal";
import { setLanguage } from "../i18n";
import { callsTo, mockFetch } from "../test/fetchMock";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";

// The owner's Switch store popup: search, favourites, add a store,
// enter one. Every word follows the reader's language.

const STORES = {
  stores: [
    { store_id: 1, name: "Lamar", address: "1 Main St", slug: "lamar", is_current: true, is_home: true },
    { store_id: 2, name: "Plaza Fiesta", address: "9 Oak Ave", slug: "plaza", is_current: false, is_home: false },
  ],
};

function routes() {
  return {
    "GET /api/v2/auth/my-stores": { body: STORES },
    "POST /api/v2/auth/my-stores": {
      body: { store_id: 3, name: "Lamar #2", address: "", slug: "lamar-2", is_current: false, is_home: false },
    },
  };
}

function open() {
  signInAs({ role: "owner" });
  return renderRoute(<SwitchStoreModal open onClose={() => {}} />);
}

describe("<SwitchStoreModal>", () => {
  it("lists the stores, marks the current one and searches", async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    open();
    expect(await screen.findByText("Plaza Fiesta")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All stores (2)" })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search stores by name or address…"), "oak");
    expect(screen.queryByText("Lamar")).toBeNull();
    expect(screen.getByText("Plaza Fiesta")).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText("Search stores by name or address…"));
    await user.type(screen.getByPlaceholderText("Search stores by name or address…"), "zzz");
    expect(screen.getByText("No stores match")).toBeInTheDocument();
  });

  it("the favourites tab is empty until a store is starred", async () => {
    window.localStorage.removeItem("db.store_favorites");
    mockFetch(routes());
    const user = userEvent.setup();
    open();
    await screen.findByText("Plaza Fiesta");
    await user.click(screen.getByRole("button", { name: "★ Favorites (0)" }));
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All stores (2)" }));
    await user.click(screen.getByRole("button", { name: "Favorite Plaza Fiesta" }));
    expect(screen.getByRole("button", { name: "Unfavorite Plaza Fiesta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "★ Favorites (1)" })).toBeInTheDocument();
    window.localStorage.removeItem("db.store_favorites");
  });

  it("adds a store with the picked business type", async () => {
    const calls = mockFetch(routes());
    const user = userEvent.setup();
    open();
    await screen.findByText("Plaza Fiesta");
    await user.click(screen.getByRole("button", { name: "Add a new store" }));
    const create = screen.getByRole("button", { name: "Create & enter →" });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("Store name"), "Lamar #2");
    await user.selectOptions(screen.getByRole("combobox"), "gas_station");
    await user.click(create);
    await waitFor(() => expect(callsTo(calls, "POST /api/v2/auth/my-stores")).toHaveLength(1));
    expect(callsTo(calls, "POST /api/v2/auth/my-stores")[0].body)
      .toEqual({ name: "Lamar #2", business_type: "gas_station" });
  });
});

describe("<SwitchStoreModal> in Spanish", () => {
  it("shows the list, tabs and empty states in Spanish", async () => {
    setLanguage("es");
    mockFetch(routes());
    const user = userEvent.setup();
    open();
    expect(await screen.findByText("Plaza Fiesta")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cambiar de tienda" })).toBeInTheDocument();
    expect(screen.getByText("Actual")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todas las tiendas (2)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Marcar Plaza Fiesta como favorita" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["switchStore."])).toEqual([]);
    await user.type(screen.getByPlaceholderText("Buscar tiendas por nombre o dirección…"), "zzz");
    expect(screen.getByText("Ninguna tienda coincide")).toBeInTheDocument();
    expect(screen.getByText("Pruebe otra búsqueda.")).toBeInTheDocument();
  });

  it("the add-store form reads in Spanish", async () => {
    setLanguage("es");
    mockFetch(routes());
    const user = userEvent.setup();
    open();
    await screen.findByText("Plaza Fiesta");
    await user.click(screen.getByRole("button", { name: "Agregar una tienda nueva" }));
    expect(screen.getByLabelText("Nombre de la tienda")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gasolinera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear y entrar →" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["switchStore.", "businessType."])).toEqual([]);
  });
});

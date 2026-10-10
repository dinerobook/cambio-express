import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PriceBook from "./PriceBook";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Price book items tab. Pinned here:
//   - Money on the item form is typed into <MoneyInput>s and reaches
//     the API as the same numbers the old number inputs sent.
//   - Editing an item prefills its money and sends it back unchanged.
//   - A refused save shows the server's reason; a failed load offers
//     Retry.
//   - Someone who can only look items up gets no add / edit controls.

const useItems = vi.fn();
const createItem = vi.fn();
const updateItem = vi.fn();

vi.mock("../api/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/catalog")>();
  return {
    ...real,
    useItems: (...a: unknown[]) => useItems(...a),
    useVendors: () => ({ data: { vendors: [] }, isLoading: false }),
    createItem: (...a: unknown[]) => createItem(...a),
    updateItem: (...a: unknown[]) => updateItem(...a),
  };
});

vi.mock("../api/dayclose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dayclose")>();
  return {
    ...real,
    useDepartments: () => ({ data: { departments: [] }, isLoading: false }),
  };
});

const ITEM = {
  id: 9, pos_code: "012345678905", pos_code_format: "upc",
  name: "Cola 12oz", department_id: null, department_name: "",
  vendor_id: null, vendor_name: "", price: 1.99, cost: 0.85,
  is_taxable: true, is_active: true, is_ebt: false, item_number: "",
  size: "12oz", case_size: 24, case_cost: 20.4, source: "manual",
};

function listOf(rows: unknown[]) {
  return {
    data: { rows, total: rows.length, page: 1, total_pages: 1 },
    isLoading: false, isError: false, refetch: vi.fn(),
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <PriceBook />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** <MoneyInput> wraps its own label, prefix and hint in one <label>,
 *  so match the label by how it starts. */
function money(label: string) {
  return screen.getByLabelText(new RegExp(`^${label}`));
}

describe("PriceBook", () => {
  beforeEach(() => {
    useItems.mockReset();
    useItems.mockReturnValue(listOf([ITEM]));
    createItem.mockReset();
    createItem.mockResolvedValue({ item: ITEM });
    updateItem.mockReset();
    updateItem.mockResolvedValue({ item: ITEM });
  });

  it("lists items with their price and cost", () => {
    renderPage();
    const row = screen.getByText("Cola 12oz").closest("tr")!;
    expect(within(row).getByText("$1.99")).toBeInTheDocument();
    expect(within(row).getByText("$0.85")).toBeInTheDocument();
  });

  it("adds an item with the typed money as numbers", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add item" }));
    await user.type(screen.getByLabelText(/^Scan code/), "049000000443");
    await user.type(screen.getByLabelText("Item name"), "Water 1L");
    await user.type(screen.getByLabelText("Case size"), "12");
    await user.type(money("Case cost"), "15");
    // 15 / 12 → the 4-decimal unit-cost hint under the case cost.
    expect(screen.getByText("Unit cost from case: $1.2500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use case" }));
    expect(money("Unit cost")).toHaveValue("1.25");
    await user.type(money("Retail price"), "2.49");
    await user.click(screen.getByRole("button", { name: "Add item" }));

    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({
      pos_code: "049000000443",
      name: "Water 1L",
      price: 2.49,
      cost: 1.25,
      case_size: 12,
      case_cost: 15,
    }));
  });

  it("requires a retail price", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add item" }));
    expect(money("Retail price")).toBeRequired();
    expect(money("Unit cost")).not.toBeRequired();
  });

  it("edits an item and sends its money back unchanged", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(money("Retail price")).toHaveValue("1.99");
    expect(money("Unit cost")).toHaveValue("0.85");
    expect(money("Case cost")).toHaveValue("20.4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    expect(updateItem).toHaveBeenCalledWith(9, expect.objectContaining({
      price: 1.99, cost: 0.85, case_size: 24, case_cost: 20.4,
    }));
  });

  it("clearing the case cost sends 0, the server's clear", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(money("Case cost"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateItem).toHaveBeenCalledTimes(1));
    expect(updateItem).toHaveBeenCalledWith(9, expect.objectContaining({
      case_cost: 0,
    }));
  });

  it("shows the server's reason when a save is refused", async () => {
    createItem.mockRejectedValue(
      new ApiError(409, "That scan code is already in the price book.", null),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "+ Add item" }));
    await user.type(screen.getByLabelText(/^Scan code/), "012345678905");
    await user.type(screen.getByLabelText("Item name"), "Dup");
    await user.type(money("Retail price"), "1");
    await user.click(screen.getByRole("button", { name: "Add item" }));
    expect(
      await screen.findByText("That scan code is already in the price book."),
    ).toBeInTheDocument();
  });

  it("a failed load offers a Retry that refetches", async () => {
    const refetch = vi.fn();
    useItems.mockReturnValue({
      data: undefined, isLoading: false, isError: true, refetch,
    });
    renderPage();
    expect(screen.getByText("Could not load the price book.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("gives someone who can only look items up no add or edit controls", () => {
    setCurrentIdentity({ ...TEST_ADMIN, permissions: ["catalog.read"] });
    renderPage();
    expect(screen.getByText("Cola 12oz")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Add item" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  });
});

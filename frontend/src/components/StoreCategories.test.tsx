import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StoreCategories } from "./StoreCategories";
import { ToastProvider } from "./ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// "Your own categories" (owner 2026-11-27: unlimited). Pinned here:
//   - hidden entirely without the switch (`enabled` false);
//   - add (name + section), rename (no section), archive behind a
//     confirm, restore at once; a refusal shows the server's reason;
//   - no `monthly.update`, no buttons;
//   - every word in Spanish.

const usePLCategories = vi.fn();
const createPLCategory = vi.fn();
const renamePLCategory = vi.fn();
const setPLCategoryArchived = vi.fn();

vi.mock("../api/monthly", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/monthly")>();
  return {
    ...real,
    usePLCategories: () => usePLCategories(),
    createPLCategory: (...a: unknown[]) => createPLCategory(...a),
    renamePLCategory: (...a: unknown[]) => renamePLCategory(...a),
    setPLCategoryArchived: (...a: unknown[]) => setPLCategoryArchived(...a),
  };
});

const ice = { id: 1, slug: "plc_1", name: "Ice", section: "expense", archived: false, in_use: 2 };
const lotto = { id: 2, slug: "plc_2", name: "Lottery", section: "income", archived: true, in_use: 1 };

function list(rows: unknown[], enabled = true) {
  usePLCategories.mockReturnValue({
    data: { enabled, rows }, isLoading: false, isError: false, refetch: vi.fn(),
  });
}

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <StoreCategories />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("StoreCategories", () => {
  beforeEach(() => {
    for (const m of [usePLCategories, createPLCategory, renamePLCategory, setPLCategoryArchived]) {
      m.mockReset();
    }
    setCurrentIdentity(TEST_ADMIN);
    list([ice, lotto]);
  });
  afterEach(() => setLanguage("en"));

  it("shows nothing without the switch", () => {
    list([], false);
    const { container } = renderIt();
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each category with its section, use and archived mark", () => {
    renderIt();
    const iceRow = screen.getByText("Ice").closest("tr")!;
    expect(within(iceRow).getByText("Expense")).toBeInTheDocument();
    expect(within(iceRow).getByText("2 transactions")).toBeInTheDocument();
    const lottoRow = screen.getByText("Lottery").closest("tr")!;
    expect(within(lottoRow).getByText("Archived")).toBeInTheDocument();
    expect(within(lottoRow).getByText("1 transaction")).toBeInTheDocument();
    expect(within(lottoRow).getByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("says so when there are none yet", () => {
    list([]);
    renderIt();
    expect(screen.getByText("No categories of your own yet.")).toBeInTheDocument();
  });

  it("adds a category with its section", async () => {
    createPLCategory.mockResolvedValue({ category: { ...ice, id: 3, name: "Rent" } });
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const dialog = screen.getByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add category" });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Name/), "Rent");
    await userEvent.selectOptions(within(dialog).getByLabelText(/Section/), "income");
    await userEvent.click(add);
    await waitFor(() => expect(createPLCategory).toHaveBeenCalledWith("Rent", "income"));
    expect(await screen.findByText("Rent added.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the server's reason when a name is taken", async () => {
    createPLCategory.mockRejectedValue(
      new ApiError(422, "You already have a category called Ice.", null),
    );
    renderIt();
    await userEvent.click(screen.getByRole("button", { name: "Add category" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Name/), "ice");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add category" }));
    expect(await within(dialog).findByText("You already have a category called Ice."))
      .toBeInTheDocument();
  });

  it("renames without offering the section", async () => {
    renamePLCategory.mockResolvedValue({ category: { ...ice, name: "Ice delivery" } });
    renderIt();
    const row = screen.getByText("Ice").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Rename" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByLabelText(/Section/)).not.toBeInTheDocument();
    const name = within(dialog).getByLabelText(/Name/);
    expect(name).toHaveValue("Ice");
    await userEvent.type(name, " delivery");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(renamePLCategory).toHaveBeenCalledWith(1, "Ice delivery"));
    expect(await screen.findByText("Renamed to Ice delivery.")).toBeInTheDocument();
  });

  it("archives only after the confirm, and restores at once", async () => {
    setPLCategoryArchived.mockResolvedValue({ category: { ...ice, archived: true } });
    renderIt();
    const row = screen.getByText("Ice").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Archive" }));
    expect(setPLCategoryArchived).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Archive Ice?")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(setPLCategoryArchived).toHaveBeenCalledWith(1, true));

    const lottoRow = screen.getByText("Lottery").closest("tr")!;
    await userEvent.click(within(lottoRow).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(setPLCategoryArchived).toHaveBeenCalledWith(2, false));
  });

  it("hides every button from someone who can only read the P&L", () => {
    setCurrentIdentity({ ...TEST_ADMIN, permissions: ["monthly.read"] });
    renderIt();
    expect(screen.getByText("Ice")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    renderIt();
    expect(screen.getByRole("heading", { name: "Sus propias categorías" })).toBeInTheDocument();
    expect(screen.getByText("Archivada")).toBeInTheDocument();
    expect(screen.getByText("2 transacciones")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["storeCat."])).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Agregar categoría" }));
    expect(englishLeftovers(document.body, ["storeCat."])).toEqual([]);
  });
});

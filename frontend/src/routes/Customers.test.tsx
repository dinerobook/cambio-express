import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Customers from "./Customers";
import type { CustomerRow } from "../api/customers";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { todayIso } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";

// Customer search page: the search box writes ?q= to the URL after a
// debounce and only past 2 characters, results come from the
// customers API, the CSV export is dated with todayIso, and merge
// (delete) / export (update) controls need their permissions. A merge
// names winner and loser, asks first, and surfaces a server refusal.

const useCustomerSearch = vi.fn();
const mergeCustomers = vi.fn();
const downloadCsv = vi.fn();
const refetch = vi.fn();

vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return {
    ...real,
    useCustomerSearch: (q: string) => useCustomerSearch(q),
    mergeCustomers: (...a: unknown[]) => mergeCustomers(...a),
  };
});
vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, downloadCsv: (...a: unknown[]) => downloadCsv(...a) };
});

function cust(id: number, name: string, over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id, full_name: name, dob: "1990-04-01", address: "1 Main St",
    phone_country: "+1", phone_number: "3055550142",
    home_store_id: 1, home_store_name: "", ...over,
  };
}
const ana = cust(1, "Ana Ruiz");
const anaDup = cust(2, "Ana Ruis", { home_store_name: "Store B" });
const luis = cust(3, "Luis Mora");

function LocationProbe() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderPage(path = "/customers") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="*" element={<><Customers /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function withPerms(drop: string[]) {
  setCurrentIdentity({
    ...TEST_ADMIN,
    permissions: TEST_ADMIN.permissions.filter((p) => !drop.includes(p)),
  });
}

beforeEach(() => {
  useCustomerSearch.mockReset();
  mergeCustomers.mockReset();
  downloadCsv.mockReset();
  refetch.mockReset();
  refetch.mockResolvedValue({});
  downloadCsv.mockResolvedValue(undefined);
  useCustomerSearch.mockReturnValue({
    data: { matches: [ana, anaDup], suggestions: [luis] },
    isFetching: false, isError: false, error: null, refetch,
  });
});

describe("Customers search", () => {
  it("prompts for 2 characters before a search and passes the URL query on", () => {
    renderPage();
    expect(screen.getByText("Type at least 2 characters to search.")).toBeInTheDocument();
    expect(useCustomerSearch).toHaveBeenLastCalledWith("");
  });

  it("writes the typed query to the URL after the debounce", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Search"), "ana");
    await waitFor(() =>
      expect(screen.getByTestId("search")).toHaveTextContent("?q=ana"));
    expect(useCustomerSearch).toHaveBeenLastCalledWith("ana");
  });

  it("does not search on a single character", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Search"), "a");
    // Past the 300ms debounce window, still nothing in the URL.
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByTestId("search")).toHaveTextContent(/^$/);
  });

  it("reads a shared link and shows matches and suggestions with masked phones", () => {
    renderPage("/customers?q=ana");
    expect(useCustomerSearch).toHaveBeenLastCalledWith("ana");
    expect(screen.getByText("2 matches · 1 suggestion")).toBeInTheDocument();
    expect(screen.getByText("Matches")).toBeInTheDocument();
    expect(screen.getByText("Suggestions")).toBeInTheDocument();
    const row = screen.getByText("Ana Ruiz").closest("tr")!;
    expect(row).toHaveTextContent("(this store)");
    // The full number is never printed in the list.
    expect(row).not.toHaveTextContent("3055550142");
    expect(screen.getByText("Ana Ruis").closest("tr")).toHaveTextContent("Store B");
  });

  it("says so when nothing matches", () => {
    useCustomerSearch.mockReturnValue({
      data: { matches: [], suggestions: [] },
      isFetching: false, isError: false, error: null, refetch,
    });
    renderPage("/customers?q=zzz");
    expect(screen.getByText('No customers match "zzz".')).toBeInTheDocument();
  });

  it("shows a retryable error when the search fails", async () => {
    useCustomerSearch.mockReturnValue({
      data: undefined, isFetching: false, isError: true,
      error: new Error("Search backend down"), refetch,
    });
    renderPage("/customers?q=ana");
    expect(screen.getByText("Search backend down")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("asks a storeless login to sign in as a store admin", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Sign in as a store admin/)).toBeInTheDocument();
  });
});

describe("Customers CSV export", () => {
  it("downloads customers_<today>.csv from the export endpoint", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    const [path, filename] = downloadCsv.mock.calls[0];
    expect(path).toBe("/api/v2/customers/export.csv");
    expect(filename).toMatch(/^customers_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(filename).toBe(`customers_${todayIso()}.csv`);
  });

  it("hides Export CSV without customers.update", () => {
    withPerms(["customers.update"]);
    renderPage();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });
});

describe("Customers merge", () => {
  async function pick(...names: string[]) {
    for (const n of names) {
      await userEvent.click(screen.getByLabelText(`Select ${n} for merge`));
    }
  }

  it("hides merge controls without customers.delete", () => {
    withPerms(["customers.delete"]);
    renderPage("/customers?q=ana");
    expect(screen.queryByRole("button", { name: "Merge duplicates" })).not.toBeInTheDocument();
    // The export control is independent of the merge right.
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("merges the first pick (winner) with the second (loser) after confirming", async () => {
    mergeCustomers.mockResolvedValue({ winner_id: 1, loser_id: 2, transfers_repointed: 3 });
    renderPage("/customers?q=ana");
    await userEvent.click(screen.getByRole("button", { name: "Merge duplicates" }));
    await pick("Ana Ruiz", "Ana Ruis");
    await userEvent.click(screen.getByRole("button", { name: "Review merge" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Winner (kept)");
    expect(mergeCustomers).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(mergeCustomers).toHaveBeenCalledWith(1, 2));
    expect(await screen.findByText(/Merged "Ana Ruis" into "Ana Ruiz" \(3 transfers re-pointed\)/))
      .toBeInTheDocument();
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it("swapping winner and loser reverses the merge direction", async () => {
    mergeCustomers.mockResolvedValue({ winner_id: 2, loser_id: 1, transfers_repointed: 0 });
    renderPage("/customers?q=ana");
    await userEvent.click(screen.getByRole("button", { name: "Merge duplicates" }));
    await pick("Ana Ruiz", "Ana Ruis");
    await userEvent.click(screen.getByRole("button", { name: "Swap winner / loser" }));
    await userEvent.click(screen.getByRole("button", { name: "Review merge" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(mergeCustomers).toHaveBeenCalledWith(2, 1));
  });

  it("only allows two picks", async () => {
    renderPage("/customers?q=ana");
    await userEvent.click(screen.getByRole("button", { name: "Merge duplicates" }));
    await pick("Ana Ruiz", "Ana Ruis");
    expect(screen.getByLabelText("Select Luis Mora for merge")).toBeDisabled();
  });

  it("shows the server's refusal inside the dialog and keeps it open", async () => {
    mergeCustomers.mockRejectedValue(new ApiError(403, "Customers belong to different owners.", null));
    renderPage("/customers?q=ana");
    await userEvent.click(screen.getByRole("button", { name: "Merge duplicates" }));
    await pick("Ana Ruiz", "Ana Ruis");
    await userEvent.click(screen.getByRole("button", { name: "Review merge" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Merge" }));
    expect(await within(screen.getByRole("dialog"))
      .findByText("Customers belong to different owners.")).toBeInTheDocument();
  });

  it("Cancel merge leaves merge mode without calling the API", async () => {
    renderPage("/customers?q=ana");
    await userEvent.click(screen.getByRole("button", { name: "Merge duplicates" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel merge" }));
    expect(screen.getByRole("button", { name: "Merge duplicates" })).toBeInTheDocument();
    expect(mergeCustomers).not.toHaveBeenCalled();
  });
});

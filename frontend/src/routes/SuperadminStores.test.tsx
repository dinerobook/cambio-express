import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminStores from "./SuperadminStores";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { SuperadminStoreRow } from "../api/superadmin";

// The platform-wide store list. Pinned: superadmin-only, server
// search over name / slug / email (the mock filters like the server
// does), sort and paging in the URL, ErrorState with retry, and the
// bulk action sends exactly the selected store ids.

const bulkStoreAction = vi.fn();
const refetch = vi.fn();
const pageHook = vi.fn();
let state: {
  data?: { rows: SuperadminStoreRow[]; total: number; page?: number; total_pages?: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/superadmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/superadmin")>();
  return {
    ...real,
    useSuperadminStoresPage: (o: { q: string }) => {
      pageHook(o);
      if (!state.data) return { ...state, refetch };
      const needle = o.q.toLowerCase();
      const rows = state.data.rows.filter((r) => !needle
        || r.name.toLowerCase().includes(needle)
        || r.slug.toLowerCase().includes(needle)
        || r.email.toLowerCase().includes(needle));
      return {
        ...state,
        data: { page: 1, total_pages: 1, ...state.data, rows, total: needle ? rows.length : state.data.total },
        refetch,
      };
    },
    bulkStoreAction: (...a: unknown[]) => bulkStoreAction(...a),
  };
});

function store(id: number, name: string, over: Partial<SuperadminStoreRow> = {}): SuperadminStoreRow {
  return {
    store_id: id, name, slug: name.toLowerCase(), email: `${name.toLowerCase()}@x.com`,
    phone: "", plan: "pro", billing_cycle: "monthly", is_active: true,
    created_at: "2026-01-01T00:00:00", trial_ends_at: "", grace_ends_at: "",
    data_retention_until: "", stripe_customer_id: "", stripe_subscription_id: "",
    ...over,
  };
}

function LocationProbe() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderPage(path = "/superadmin/stores") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <SuperadminStores />
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("SuperadminStores", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    bulkStoreAction.mockReset();
    bulkStoreAction.mockResolvedValue({ count: 2 });
    refetch.mockReset();
    pageHook.mockReset();
    localStorage.removeItem("db.page_size.superadmin-stores");
    state = {
      data: {
        rows: [
          store(1, "Alpha", { plan: "trial", trial_ends_at: "2026-11-01T00:00:00" }),
          store(2, "Bravo", { is_active: false, data_retention_until: "2027-03-01T00:00:00" }),
          store(3, "Charlie"),
        ],
        total: 3,
      },
      isLoading: false, isError: false,
    };
  });

  it("refuses anyone but a superadmin", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("lists stores with plan, status and trial / retention", () => {
    renderPage();
    const alpha = screen.getByText("Alpha").closest("tr")!;
    expect(alpha).toHaveTextContent("Trial");
    expect(alpha).toHaveTextContent("Trial ends");
    const bravo = screen.getByText("Bravo").closest("tr")!;
    expect(within(bravo).getByText("Inactive")).toBeInTheDocument();
    expect(bravo).toHaveTextContent("Purge");
    expect(screen.getByText("3 stores")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–3 of 3")).toBeInTheDocument();
  });

  it("asks the server for newest stores first, 50 a page", () => {
    renderPage();
    expect(pageHook).toHaveBeenLastCalledWith({
      q: "", sort: "created", dir: "desc", page: 1, perPage: 50,
    });
  });

  it("searches on the server as you type, after two characters", async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "brav");
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(pageHook).toHaveBeenLastCalledWith(expect.objectContaining({ q: "brav", page: 1 }));
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("1 store match")).toBeInTheDocument();
    expect(screen.getByTestId("search")).toHaveTextContent("q=brav");
    await userEvent.clear(screen.getByPlaceholderText(/Search name/));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "zzz");
    expect(await screen.findByText("No stores match these filters.")).toBeInTheDocument();
  });

  it("reads the search from a shared link", () => {
    renderPage("/superadmin/stores?q=charlie");
    expect(pageHook).toHaveBeenLastCalledWith(expect.objectContaining({ q: "charlie" }));
    expect(screen.getByText("Charlie")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("sorts by a column header and keeps it in the URL", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /^Store/ }));
    expect(pageHook).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "name", dir: "asc", page: 1 }),
    );
    expect(screen.getByTestId("search")).toHaveTextContent("sort=name");
  });

  it("pages through a long list and offers rows per page", async () => {
    state.data = { ...state.data!, total: 120, page: 1, total_pages: 3 };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(pageHook).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "100");
    expect(pageHook).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, perPage: 100 }));
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "Stores are down", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Stores are down");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("applies a bulk action to exactly the selected stores", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.click(screen.getByLabelText("Select Charlie"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "extend_trial");
    await userEvent.click(apply);
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([1, 3], "extend_trial"));
    expect(await screen.findByText("2 stores updated.")).toBeInTheDocument();
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();
  });

  it("keeps the selection and shows the refusal when a bulk action fails", async () => {
    bulkStoreAction.mockRejectedValue(new ApiError(400, "Cannot disable a paid store.", null));
    renderPage();
    await userEvent.click(screen.getByLabelText("Select all stores"));
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "disable");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([1, 2, 3], "disable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot disable a paid store.");
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  // Selection follows the search: a hidden store is never counted or acted on.
  it("does not show 'select all' as checked when only a hidden store is selected", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "charlie");
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Select Charlie")).not.toBeChecked();
    expect(screen.getByLabelText("Select all stores")).not.toBeChecked();
  });

  it("applies a bulk action only to the stores the search shows", async () => {
    renderPage();
    await userEvent.click(screen.getByLabelText("Select Alpha"));
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "charlie");
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Select all stores"));
    expect(screen.getByLabelText("Select Charlie")).toBeChecked();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByDisplayValue("— Choose action —"), "enable");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bulkStoreAction).toHaveBeenCalledWith([3], "enable"));
  });
});

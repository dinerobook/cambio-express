import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Transfers from "./Transfers";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Transfers list: filters and page live in the URL, the query sent to
// the API follows them (search only from 2 characters), each row shows
// its total, and "New transfer" is only offered to someone who may
// create one.

const useTransfers = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return { ...real, useTransfers: (...a: unknown[]) => useTransfers(...a) };
});

const rows = [
  {
    id: 1, send_date: "2026-10-03", company: "Intermex",
    service_type: "Money Transfer", sender_name: "Maria Lopez",
    recipient_name: "Juan Garcia", country: "Mexico", confirm_number: "ABC123",
    send_amount: 1000, fee: 7.5, federal_tax: 10, total_collected: 1017.5,
    status: "Sent", batch_id: "", employee_name: "Rosa",
  },
  {
    id: 2, send_date: "2026-10-02", company: "Maxi",
    service_type: "Money Transfer", sender_name: "Ana Ruiz",
    recipient_name: "", country: "", confirm_number: "",
    send_amount: 50, fee: 3, federal_tax: 0.5, total_collected: 53.5,
    status: "Pending", batch_id: "", employee_name: "Tom",
  },
];

function result(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      rows, total: 2, page: 1, per_page: 50, total_pages: 1, page_amount: 0,
    },
    dataUpdatedAt: 0, isLoading: false, isFetching: false, isError: false,
    error: null, refetch: vi.fn(), ...overrides,
  };
}

function LocationProbe() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderPage(path = "/transfers") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/transfers"
            element={<><Transfers /><LocationProbe /></>}
          />
          <Route path="/transfers/:id" element={<div>detail page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastArgs = () => useTransfers.mock.lastCall![0];

describe("Transfers list", () => {
  beforeEach(() => {
    useTransfers.mockReset();
    useTransfers.mockReturnValue(result());
  });

  it("renders each row with its total collected", () => {
    renderPage();
    const maria = screen.getByText("Maria Lopez").closest("tr")!;
    expect(maria).toHaveTextContent("Intermex");
    expect(maria).toHaveTextContent("ABC123");
    expect(maria).toHaveTextContent("$1,017.50");
    const ana = screen.getByText("Ana Ruiz").closest("tr")!;
    expect(ana).toHaveTextContent("$53.50");
    expect(within(ana).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("2 total · page 1 of 1")).toBeInTheDocument();
  });

  it("opens a transfer when its row is clicked", async () => {
    renderPage();
    await userEvent.setup().click(screen.getByText("Maria Lopez"));
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("reads filters from the URL and passes them to the query", () => {
    renderPage("/transfers?status=Pending&date_from=2026-10-01&q=ana&page=2");
    expect(lastArgs()).toMatchObject({
      status: "Pending", date_from: "2026-10-01", q: "ana", page: 2,
    });
    expect(screen.getByLabelText("Status")).toHaveValue("Pending");
  });

  it("puts a changed status in the URL and returns to page 1", async () => {
    renderPage("/transfers?page=3");
    await userEvent.setup().selectOptions(screen.getByLabelText("Status"), "Cancelled");
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toContain("status=Cancelled"));
    expect(screen.getByTestId("search").textContent).not.toContain("page=3");
    expect(lastArgs().status).toBe("Cancelled");
  });

  it("debounces the search and ignores one character", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText("Search"), "m");
    expect(screen.getByTestId("search").textContent).toBe("");
    await user.type(screen.getByLabelText("Search"), "aria");
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toContain("q=maria"));
    expect(lastArgs().q).toBe("maria");
  });

  it("does not send a one-character search to the API", () => {
    renderPage("/transfers?q=m");
    expect(lastArgs().q).toBeUndefined();
  });

  it("says so when nothing matches, and retries on error", async () => {
    const refetch = vi.fn();
    useTransfers.mockReturnValue(result({
      data: { rows: [], total: 0, page: 1, per_page: 50, total_pages: 0, page_amount: 0 },
    }));
    const { unmount } = renderPage();
    expect(screen.getByText("No transfers match these filters.")).toBeInTheDocument();
    unmount();

    useTransfers.mockReturnValue(result({
      data: undefined, isError: true, error: new Error("boom"), refetch,
    }));
    renderPage();
    await userEvent.setup().click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers New transfer only with transfers.create", () => {
    const { unmount } = renderPage();
    expect(screen.getByRole("link", { name: /New transfer/ }))
      .toHaveAttribute("href", "/transfers/new");
    unmount();

    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["transfers.read"],
    });
    renderPage();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /New transfer/ })).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminTickets from "./SuperadminTickets";
import { ToastProvider } from "../components/ui";

// The platform ticket queue: search (debounced, 2-char minimum),
// store filter and paging all live in the URL and reach the API
// through one query-string builder. These tests pin that the
// controls drive the fetch, not that the server filters.

const useAllTickets = vi.fn();
const useSuperadminStores = vi.fn();

vi.mock("../api/support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/support")>();
  return {
    ...actual,
    useAllTickets: (...args: unknown[]) => useAllTickets(...args),
    claimTicket: vi.fn(), releaseTicket: vi.fn(), updateTicket: vi.fn(),
  };
});
vi.mock("../api/superadmin", () => ({
  useSuperadminStores: () => useSuperadminStores(),
}));
vi.mock("../components/TicketThread", () => ({
  TicketThread: () => <div data-testid="thread" />,
}));

const ticket = (id: number, subject: string, store: string) => ({
  id, store_id: id, user_id: 1, submitted_by: "Maria", category: "bug",
  priority: null, subject, body: "…", status: "open", admin_reply: null,
  replied_at: null, replied_by: null, created_at: "2026-10-08T12:00:00",
  updated_at: "2026-10-08T12:00:00", closed_at: null, store_name: store,
  assigned_to_user_id: null, assigned_to_name: null, unread_count: 0,
});

function renderAt(path = "/superadmin/tickets") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/superadmin/tickets" element={<SuperadminTickets />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function lastFilters() {
  return useAllTickets.mock.calls[useAllTickets.mock.calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "superadmin", full_name: "Platform Admin",
    role: "superadmin", store_id: null, permissions: [],
  }));
  useAllTickets.mockReset();
  useAllTickets.mockReturnValue({
    data: {
      tickets: [ticket(1, "Printer jams", "Cambio Express"), ticket(2, "Wrong fee", "La Tienda")],
      total: 120, page: 1, per_page: 50, total_pages: 3,
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  });
  useSuperadminStores.mockReturnValue({
    data: { rows: [{ store_id: 1, name: "Cambio Express" }, { store_id: 2, name: "La Tienda" }], total: 2 },
  });
});

describe("<SuperadminTickets> filters", () => {
  it("starts unfiltered and lists the tickets with their store", () => {
    renderAt();
    expect(lastFilters()).toMatchObject({ q: "", status: "", category: "", store_id: "", page: 1 });
    expect(screen.getByText("Printer jams")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "La Tienda" })).toHaveAttribute("href", "/superadmin/stores/2");
  });

  it("the search box reaches the API after the debounce, not per keystroke", async () => {
    renderAt();
    const box = screen.getByRole("searchbox", { name: /search tickets/i });
    await userEvent.type(box, "fee");
    // Typed value shows at once; the URL (and so the query) waits.
    expect(box).toHaveValue("fee");
    expect(lastFilters().q).toBe("");
    await waitFor(() => expect(lastFilters().q).toBe("fee"), { timeout: 1500 });
  });

  it("a one-character search never reaches the API", async () => {
    renderAt();
    await userEvent.type(screen.getByRole("searchbox", { name: /search tickets/i }), "f");
    await new Promise((r) => setTimeout(r, 450));
    expect(lastFilters().q).toBe("");
  });

  it("the store filter applies at once and resets the page", async () => {
    renderAt("/superadmin/tickets?page=2");
    expect(lastFilters().page).toBe(2);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Store" }), "2");
    await waitFor(() => expect(lastFilters()).toMatchObject({ store_id: "2", page: 1 }));
    expect(screen.getByText(/120 tickets matching/)).toBeInTheDocument();
  });

  it("paging moves through the server's pages", async () => {
    renderAt();
    await userEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(lastFilters().page).toBe(2));
  });

  it("filters restore from the URL", () => {
    renderAt("/superadmin/tickets?q=printer&status=open&store_id=1&page=3");
    expect(lastFilters()).toMatchObject({ q: "printer", status: "open", store_id: "1", page: 3 });
    expect(screen.getByRole("searchbox", { name: /search tickets/i })).toHaveValue("printer");
  });
});

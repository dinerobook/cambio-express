import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminTickets from "./SuperadminTickets";
import { ToastProvider } from "../components/ui";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

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
  localStorage.removeItem("db.page_size.superadmin-tickets");
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

  it("shows how many tickets there are and offers rows per page", async () => {
    renderAt("/superadmin/tickets?page=2");
    expect(screen.getByText(/of 120$/)).toBeInTheDocument();
    expect(lastFilters()).toMatchObject({ perPage: 50 });
    await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "25");
    await waitFor(() => expect(lastFilters()).toMatchObject({ perPage: 25, page: 1 }));
    expect(localStorage.getItem("db.page_size.superadmin-tickets")).toBe("25");
  });

  it("filters restore from the URL", () => {
    renderAt("/superadmin/tickets?q=printer&status=open&store_id=1&page=3");
    expect(lastFilters()).toMatchObject({ q: "printer", status: "open", store_id: "1", page: 3 });
    expect(screen.getByRole("searchbox", { name: /search tickets/i })).toHaveValue("printer");
  });
});

describe("<SuperadminTickets> in Spanish", () => {
  it("reads in Spanish: filters, a ticket card and its controls", async () => {
    useAllTickets.mockReturnValue({
      data: {
        tickets: [{ ...ticket(1, "Printer jams", "Cambio Express"), unread_count: 2, priority: "P2", status: "in_progress" }],
        total: 1, page: 1, per_page: 50, total_pages: 1,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
    setLanguage("es");
    renderAt();
    expect(screen.getByText("1 ticket en todas las tiendas")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Todas las categorías" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Todos los estados" })).toBeInTheDocument();
    expect(screen.getByText("2 nuevos")).toBeInTheDocument();
    expect(screen.getAllByText("En curso").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reporte de falla").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Tomar" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saTix.", "support."])).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Abrir conversación" }));
    expect(screen.getByRole("button", { name: "Actualizar estado" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "P2 — Alta" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saTix.", "support."])).toEqual([]);
  });

  it("shows a status or category it doesn't know as sent", () => {
    useAllTickets.mockReturnValue({
      data: {
        tickets: [{ ...ticket(1, "Odd one", "Cambio Express"), status: "on_hold", category: "billing" }],
        total: 1, page: 1, per_page: 50, total_pages: 1,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
    renderAt();
    expect(screen.getByText("on hold")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
  });
});

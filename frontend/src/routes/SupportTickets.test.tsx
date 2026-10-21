import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SupportTickets from "./SupportTickets";
import { ApiError } from "../lib/api";
import { renderRoute, renderRouteWithGuard, signInAs } from "../test/renderRoute";

// The store's own support tickets: a paged list on the shared table,
// a row opens its conversation underneath (mouse or keyboard), the
// new-ticket form submits, and a superadmin is sent to the queue.

const useMyTickets = vi.fn();
const createTicket = vi.fn();
const refetch = vi.fn();

vi.mock("../api/support", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/support")>();
  return {
    ...real,
    useMyTickets: (o: unknown) => useMyTickets(o),
    createTicket: (b: unknown) => createTicket(b),
  };
});
vi.mock("../components/TicketThread", () => ({
  TicketThread: ({ ticket }: { ticket: { subject: string } }) => (
    <div data-testid="thread">Thread for {ticket.subject}</div>
  ),
}));

const ticket = (id: number, subject: string, over: Record<string, unknown> = {}) => ({
  id, store_id: 1, user_id: 1, submitted_by: "Maria", category: "bug",
  priority: null, subject, body: "…", status: "open", admin_reply: null,
  replied_at: null, replied_by: null, created_at: "2026-10-08T12:00:00",
  updated_at: "2026-10-08T12:00:00", closed_at: null, store_name: "",
  assigned_to_user_id: null, assigned_to_name: null, unread_count: 0,
  ...over,
});

function listed(tickets: unknown[], extra: Record<string, unknown> = {}) {
  return {
    data: { tickets, total: tickets.length, page: 1, per_page: 50, total_pages: 1, ...extra },
    isLoading: false, isError: false, refetch,
  };
}

function renderPage(at = "/account/tickets") {
  return renderRoute(<SupportTickets />, { path: "/account/tickets", at });
}

describe("SupportTickets", () => {
  beforeEach(() => {
    signInAs();
    localStorage.removeItem("db.page_size.support-tickets");
    useMyTickets.mockReset();
    createTicket.mockReset();
    refetch.mockReset();
    useMyTickets.mockReturnValue(listed([
      ticket(1, "Printer jams", { unread_count: 2 }),
      ticket(2, "Add a report", { category: "feature", status: "resolved" }),
    ]));
  });

  it("lists tickets with category, status and unread replies", () => {
    renderPage();
    const jam = screen.getByText("Printer jams").closest("tr")!;
    expect(jam).toHaveTextContent("Bug report");
    expect(jam).toHaveTextContent("open");
    expect(screen.getByTitle("2 new replies")).toHaveTextContent("2");
    expect(screen.getByText("Add a report").closest("tr")).toHaveTextContent("Feature request");
    expect(screen.getByText("Showing 1–2 of 2")).toBeInTheDocument();
  });

  it("asks for page 1 with 50 rows by default", () => {
    renderPage();
    expect(useMyTickets).toHaveBeenLastCalledWith({ page: 1, perPage: 50 });
  });

  it("opens and closes a conversation under its row", async () => {
    renderPage();
    const row = screen.getByRole("button", { name: "Open ticket Printer jams" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByText("Printer jams"));
    expect(screen.getByTestId("thread")).toHaveTextContent("Thread for Printer jams");
    expect(row).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByText("Printer jams"));
    expect(screen.queryByTestId("thread")).not.toBeInTheDocument();
  });

  it("opens a conversation from the keyboard", async () => {
    renderPage();
    screen.getByRole("button", { name: "Open ticket Add a report" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("thread")).toHaveTextContent("Thread for Add a report");
  });

  it("pages through a long list, page kept in the URL", async () => {
    useMyTickets.mockReturnValue(listed(
      [ticket(1, "Printer jams")], { total: 80, total_pages: 2 },
    ));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(useMyTickets).toHaveBeenLastCalledWith({ page: 2, perPage: 50 });
  });

  it("reads the page from a shared link", () => {
    renderPage("/account/tickets?page=3");
    expect(useMyTickets).toHaveBeenLastCalledWith({ page: 3, perPage: 50 });
  });

  it("shows an empty state when the store has no tickets", () => {
    useMyTickets.mockReturnValue(listed([]));
    renderPage();
    expect(screen.getByText("No tickets yet")).toBeInTheDocument();
  });

  it("shows the error with a working retry", async () => {
    useMyTickets.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "Down", null), refetch,
    });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("submits a new ticket", async () => {
    createTicket.mockResolvedValue({ ticket: ticket(3, "Help") });
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New ticket" }));
    await user.type(screen.getByPlaceholderText("Brief summary"), "Help");
    await user.type(screen.getByPlaceholderText(/Describe the issue/), "It broke");
    await user.click(screen.getByRole("button", { name: "Submit ticket" }));
    await waitFor(() => expect(createTicket).toHaveBeenCalledWith({
      category: "question", subject: "Help", body: "It broke",
    }));
    expect(await screen.findByText(/Ticket submitted/)).toBeInTheDocument();
  });

  it("shows the server's refusal when a ticket cannot be filed", async () => {
    createTicket.mockRejectedValue(new ApiError(400, "Subject too long.", null));
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New ticket" }));
    await user.type(screen.getByPlaceholderText("Brief summary"), "Help");
    await user.type(screen.getByPlaceholderText(/Describe the issue/), "It broke");
    await user.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Subject too long.");
  });

  it("sends a superadmin to the platform queue", () => {
    signInAs({ role: "superadmin", store_id: null });
    renderPage();
    expect(screen.getByText(/Navigated to \/superadmin\/tickets/)).toBeInTheDocument();
  });

  it("asks before leaving a typed ticket; a submitted one leaves freely", async () => {
    createTicket.mockResolvedValue({ ticket: ticket(3, "Help") });
    const { router } = renderRouteWithGuard(<SupportTickets />, { path: "/account/tickets" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ New ticket" }));
    // Picking a category alone is not work to protect.
    await user.selectOptions(screen.getByLabelText("Category"), "feature");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.type(screen.getByPlaceholderText("Brief summary"), "Help");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    act(() => { void router.navigate("/dashboard"); });
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(screen.getByPlaceholderText("Brief summary")).toHaveValue("Help");

    await user.type(screen.getByPlaceholderText(/Describe the issue/), "It broke");
    await user.click(screen.getByRole("button", { name: "Submit ticket" }));
    expect(await screen.findByText(/Ticket submitted/)).toBeInTheDocument();
    act(() => { void router.navigate("/dashboard"); });
    expect(await screen.findByText("Navigated to /dashboard")).toBeInTheDocument();
  });
});

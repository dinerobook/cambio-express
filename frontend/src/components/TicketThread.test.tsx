import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TicketThread } from "./TicketThread";
import { ApiError } from "../lib/api";
import type { TicketRow } from "../api/support";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// One ticket's conversation, shared by the store's Support page and
// the superadmin queue. It had no tests. Pinned: the ticket body is
// the first bubble, a staff reply without a name reads "Support", an
// open ticket takes a reply, a closed one offers Reopen instead, and
// a refused send shows its reason.

const postTicketMessage = vi.fn();
const reopenTicket = vi.fn();
let messages: { id: number; author_kind: string; author_name: string; created_at: string; body: string }[];

vi.mock("../api/support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/support")>()),
  useTicketMessages: () => ({ data: { messages }, isLoading: false, isSuccess: true }),
  postTicketMessage: (...a: unknown[]) => postTicketMessage(...a),
  reopenTicket: (...a: unknown[]) => reopenTicket(...a),
}));

const TICKET = {
  id: 9, subject: "Printer jams", body: "It jams on every receipt.",
  submitted_by: "Maria", created_at: "2026-10-08T12:00:00", status: "open",
} as unknown as TicketRow;

function renderThread(ticket: TicketRow = TICKET) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TicketThread ticket={ticket} viewerKind="user" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  postTicketMessage.mockReset().mockResolvedValue({});
  reopenTicket.mockReset().mockResolvedValue({});
  messages = [
    { id: 1, author_kind: "staff", author_name: "", created_at: "2026-10-08T13:00:00", body: "Which printer?" },
  ];
});

describe("<TicketThread>", () => {
  it("shows the ticket body first and names an unnamed staff reply Support", () => {
    renderThread();
    expect(screen.getByText("It jams on every receipt.")).toBeInTheDocument();
    expect(screen.getByText(/^Support ·/)).toBeInTheDocument();
  });

  it("sends a trimmed reply on an open ticket", async () => {
    renderThread();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("Write a reply…"), "  The Epson  ");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(postTicketMessage).toHaveBeenCalledWith(9, "The Epson"));
  });

  it("shows why a reply was refused", async () => {
    postTicketMessage.mockRejectedValue(new ApiError(403, "Ticket is locked.", null));
    renderThread();
    await userEvent.type(screen.getByPlaceholderText("Write a reply…"), "Hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Ticket is locked.")).toBeInTheDocument();
  });

  it("offers Reopen instead of a reply box on a closed ticket", async () => {
    renderThread({ ...TICKET, status: "closed" } as TicketRow);
    expect(screen.queryByPlaceholderText("Write a reply…")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(reopenTicket).toHaveBeenCalledWith(9));
  });

  it("reads in Spanish, open and closed", () => {
    setLanguage("es");
    const { unmount } = renderThread();
    expect(screen.getByText(/^Soporte ·/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Escriba una respuesta…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["ticket."])).toEqual([]);
    unmount();
    renderThread({ ...TICKET, status: "closed" } as TicketRow);
    expect(screen.getByText("Este ticket está cerrado. ¿Sigue con el problema?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reabrir el ticket" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["ticket."])).toEqual([]);
  });
});

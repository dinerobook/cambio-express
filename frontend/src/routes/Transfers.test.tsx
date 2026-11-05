import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Transfers from "./Transfers";
import { ToastProvider } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Transfers list: filters and page live in the URL, the query sent to
// the API follows them (search only from 2 characters), each row shows
// its total, and "New transfer" is only offered to someone who may
// create one.

const useTransfers = vi.fn();
const fetchTransfersPage = vi.fn();

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useTransfers: (...a: unknown[]) => useTransfers(...a),
    fetchTransfersPage: (...a: unknown[]) => fetchTransfersPage(...a),
  };
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
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/transfers"
              element={<><Transfers /><LocationProbe /></>}
            />
            <Route path="/transfers/:id" element={<div>detail page</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
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
    expect(screen.getByText("2 transfers")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 2")).toBeInTheDocument();
  });

  it("opens a transfer from the keyboard too", async () => {
    const user = userEvent.setup();
    renderPage();
    screen.getByRole("button", { name: "Open transfer from Maria Lopez" }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("detail page")).toBeInTheDocument();
  });

  it("sorts newest first by default and by a clicked column", async () => {
    const user = userEvent.setup();
    renderPage("/transfers?page=2");
    expect(lastArgs()).toMatchObject({ sort: "date", dir: "desc" });
    await user.click(screen.getByRole("button", { name: /Sender/ }));
    await waitFor(() => expect(lastArgs()).toMatchObject({ sort: "sender", dir: "asc" }));
    expect(screen.getByTestId("search").textContent).not.toContain("page=2");
    await user.click(screen.getByRole("button", { name: /Sender/ }));
    await waitFor(() => expect(lastArgs()).toMatchObject({ sort: "sender", dir: "desc" }));
    // Money starts largest first.
    await user.click(screen.getByRole("button", { name: /Total/ }));
    await waitFor(() => expect(lastArgs()).toMatchObject({ sort: "total", dir: "desc" }));
  });

  it("changes rows per page and asks the API for that many", async () => {
    window.localStorage.removeItem("db.page_size.transfers");
    useTransfers.mockReturnValue(result({
      data: { rows, total: 120, page: 1, per_page: 50, total_pages: 3, page_amount: 0 },
    }));
    renderPage();
    expect(lastArgs().perPage).toBe(50);
    await userEvent.setup().selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(lastArgs().perPage).toBe(100));
    window.localStorage.removeItem("db.page_size.transfers");
  });

  it("pages through the list and keeps the page in the URL", async () => {
    useTransfers.mockReturnValue(result({
      data: { rows, total: 52, page: 1, per_page: 50, total_pages: 2, page_amount: 0 },
    }));
    renderPage();
    expect(screen.getByText("Showing 1–2 of 52")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toContain("page=2"));
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

  it("marks payouts (as cash out) and debit card sends", () => {
    useTransfers.mockReturnValue(result({ data: {
      rows: [
        { ...rows[0], id: 5, sender_name: "Paid Here", service_type: "Payout",
          payment_method: "cash", fee: 0, federal_tax: 0, total_collected: 400 },
        { ...rows[1], id: 6, sender_name: "Card Payer", payment_method: "debit_card" },
        { ...rows[1], id: 7, sender_name: "Cash Payer", payment_method: "cash" },
      ],
      total: 3, page: 1, per_page: 50, total_pages: 1, page_amount: 0,
    } }));
    renderPage();
    const payout = screen.getByText("Paid Here").closest("tr")!;
    expect(within(payout).getByText("Payout")).toBeInTheDocument();
    expect(payout).toHaveTextContent("-$400.00");
    const card = screen.getByText("Card Payer").closest("tr")!;
    expect(within(card).getByText("Debit card")).toBeInTheDocument();
    expect(card).toHaveTextContent("$53.50");
    const cash = screen.getByText("Cash Payer").closest("tr")!;
    expect(within(cash).queryByText("Debit card")).not.toBeInTheDocument();
    expect(within(cash).queryByText("Payout")).not.toBeInTheDocument();
  });

  it("filters by service and by how it was paid, through the URL", async () => {
    renderPage("/transfers?service=Payout&page=2");
    expect(lastArgs()).toMatchObject({ service: "Payout", page: 2 });
    expect(screen.getByLabelText("Service")).toHaveValue("Payout");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Paid by"), "debit_card");
    await waitFor(() =>
      expect(screen.getByTestId("search").textContent).toContain("paid_by=debit_card"));
    expect(screen.getByTestId("search").textContent).not.toContain("page=2");
    expect(lastArgs()).toMatchObject({ service: "Payout", paid_by: "debit_card" });
  });
});

describe("Transfers CSV export", () => {
  /** What the export saved, instead of a real download. */
  function captureDownloads() {
    const saved: { name: string; blob: Blob }[] = [];
    let last: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { last = b as Blob; return "blob:x"; });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push({ name: this.download, blob: last! });
    });
    return saved;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    fetchTransfersPage.mockReset();
    useTransfers.mockReturnValue(result({
      data: { rows, total: 3, page: 1, per_page: 2, total_pages: 2, page_amount: 0 },
    }));
  });

  it("exports every page the current filters match, with the total's parts", async () => {
    const saved = captureDownloads();
    fetchTransfersPage.mockImplementation((_store: number, q: { page: number }) => Promise.resolve({
      rows: q.page === 1 ? rows : [{ ...rows[0], id: 3, sender_name: "Luis Mora", service_type: "Payout", payment_method: "debit_card" }],
      total: 3, page: q.page, per_page: 100, total_pages: 2, page_amount: 0,
    }));
    renderPage("/transfers?status=Sent&q=ma&date_from=2026-10-01&sort=total&dir=asc");
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));

    // The same filters and sort as the list, 100 rows at a time.
    expect(fetchTransfersPage).toHaveBeenCalledTimes(2);
    expect(fetchTransfersPage.mock.calls[0][1]).toMatchObject({
      status: "Sent", q: "ma", date_from: "2026-10-01", sort: "total", dir: "asc",
      page: 1, perPage: 100,
    });
    expect(fetchTransfersPage.mock.calls[1][1]).toMatchObject({ page: 2, status: "Sent" });

    expect(saved[0].name).toMatch(/^transfers-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = (await saved[0].blob.text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe(
      "Date,Company,Sender,Recipient,Country,Confirmation #,Status,Total,"
      + "Service,Paid by,Send amount,Fee,Federal tax,Employee",
    );
    expect(lines[1]).toBe(
      "2026-10-03,Intermex,Maria Lopez,Juan Garcia,Mexico,ABC123,Sent,1017.50,"
      + "Money Transfer,Cash,1000.00,7.50,10.00,Rosa",
    );
    // A payout is cash going out: negative, like on screen.
    expect(lines[3]).toContain("Luis Mora");
    expect(lines[3]).toContain(",-1017.50,Payout,Debit card,");
    expect(lines).toHaveLength(5);
  });

  it("is not offered to a cashier without Reports access", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["transfers.read", "transfers.create"],
    });
    renderPage();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
  });

  it("is offered once Reports access is granted", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["transfers.read", "reports.read"],
    });
    renderPage();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("toasts a failed export and saves nothing", async () => {
    const saved = captureDownloads();
    fetchTransfersPage.mockRejectedValue(new Error("network"));
    renderPage();
    await userEvent.setup().click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Export failed. Please try again.")).toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankTransactions from "./BankTransactions";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// "Sync transactions" result reporting. A failed sync used to land
// in the same green success banner as a good one, so an operator
// saw "Bank feed unavailable" styled as a win. Success is now a
// success toast; failure is an error toast (role="alert").

const syncBankTransactions = vi.fn();
const useBankTransactions = vi.fn();
const EMPTY = {
  data: {
    rows: [], total: 0, page: 1, per_page: 50, total_pages: 1,
    page_total_cents: 0, uncategorized_count: 0,
  },
  isLoading: false, isError: false, refetch: vi.fn(),
};

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    syncBankTransactions: (...a: unknown[]) => syncBankTransactions(...a),
    useBankAccounts: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
    useBankCategories: () => ({ data: { groups: [] }, isLoading: false, isError: false }),
    useBankTransactions: (...a: unknown[]) => useBankTransactions(...a) ?? EMPTY,
  };
});

function renderPage(at = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[at]}>
          <BankTransactions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("BankTransactions sync", () => {
  beforeEach(() => {
    syncBankTransactions.mockReset();
  });

  it("reports a successful sync as a success toast", async () => {
    syncBankTransactions.mockResolvedValue({ new_rows: 3 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    const msg = await screen.findByText("Synced 3 new transactions.");
    expect(msg.closest("[role]")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the singular for one new row", async () => {
    syncBankTransactions.mockResolvedValue({ new_rows: 1 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    expect(await screen.findByText("Synced 1 new transaction.")).toBeInTheDocument();
  });

  it("reports a failed sync as an error, with the server's message", async () => {
    syncBankTransactions.mockRejectedValue(
      new ApiError(502, "Bank feed unavailable", null),
    );
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Bank feed unavailable");
    expect(screen.queryByText(/^Synced/)).not.toBeInTheDocument();
  });

  it("falls back to a generic message for a non-API failure", async () => {
    syncBankTransactions.mockRejectedValue(new TypeError("fetch failed"));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /sync transactions/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sync failed.");
  });

  it("re-enables the button once the sync settles", async () => {
    syncBankTransactions.mockRejectedValue(new Error("x"));
    renderPage();
    const btn = screen.getByRole("button", { name: /sync transactions/i });
    await userEvent.click(btn);
    await waitFor(() => expect(btn).not.toBeDisabled());
  });
});

describe("BankTransactions list", () => {
  const row = {
    id: 5, posted_at: "2026-10-03T12:00:00", description: "REMOTE DEPOSIT FEE",
    account_id: 1, account_label: "MSB ••0230", category_slug: "",
    amount: -2.5, amount_cents: -250, booked_on: null,
  };
  const last = () => useBankTransactions.mock.lastCall![0];

  beforeEach(() => {
    useBankTransactions.mockReset();
    useBankTransactions.mockReturnValue({
      ...EMPTY,
      data: {
        ...EMPTY.data, rows: [row], total: 70, total_pages: 2,
        page_total_cents: -250,
      },
    });
    window.localStorage.removeItem("db.page_size.bank-transactions");
  });

  it("shows rows, the row range and the page total", () => {
    renderPage();
    expect(screen.getByText("REMOTE DEPOSIT FEE")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 70")).toBeInTheDocument();
    expect(screen.getByText(/Page total/)).toHaveTextContent("-$2.50");
    expect(last()).toMatchObject({ sort: "posted", dir: "desc", page: 1, per_page: 50 });
  });

  it("searches as you type, from two characters, back on page 1", async () => {
    const user = userEvent.setup();
    renderPage("/?page=2");
    expect(last().page).toBe(2);
    await user.type(screen.getByLabelText("Search"), "f");
    expect(last().q).toBe("");
    await user.type(screen.getByLabelText("Search"), "ee");
    await waitFor(() => expect(last()).toMatchObject({ q: "fee", page: 1 }));
  });

  it("sorts by a clicked column and changes rows per page", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    await waitFor(() => expect(last()).toMatchObject({ sort: "amount", dir: "desc" }));
    await user.selectOptions(screen.getByLabelText("Rows per page"), "100");
    await waitFor(() => expect(last().per_page).toBe(100));
  });
});

// Tabs: rows still needing a person (the bell's rule, worked out by
// the server) are the default view; tagged / matched / dismissed rows
// sit under Reconciled; All lists everything. The tab lives in the URL.
describe("BankTransactions tabs", () => {
  const last = () => useBankTransactions.mock.lastCall![0];

  beforeEach(() => {
    useBankTransactions.mockReset();
    useBankTransactions.mockReturnValue({
      ...EMPTY,
      data: { ...EMPTY.data, to_reconcile_count: 4, reconciled_count: 12 },
    });
  });

  it("opens on To reconcile, with each tab's count", () => {
    renderPage();
    expect(last()).toMatchObject({ tab: "to_reconcile" });
    expect(screen.getByRole("tab", { name: "To reconcile (4)" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Reconciled (12)" }))
      .toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
  });

  it("Reconciled and All change the list and come back to page 1", async () => {
    const user = userEvent.setup();
    renderPage("/?page=2");
    await user.click(screen.getByRole("tab", { name: "Reconciled (12)" }));
    await waitFor(() => expect(last()).toMatchObject({ tab: "reconciled", page: 1 }));
    expect(screen.getByRole("tab", { name: "Reconciled (12)" }))
      .toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(last()).toMatchObject({ tab: "" }));
    await user.click(screen.getByRole("tab", { name: "To reconcile (4)" }));
    await waitFor(() => expect(last()).toMatchObject({ tab: "to_reconcile" }));
  });

  it("reads the tab back from the URL; an unknown one is To reconcile", () => {
    renderPage("/?tab=reconciled");
    expect(last()).toMatchObject({ tab: "reconciled" });
    renderPage("/?tab=nonsense");
    expect(last()).toMatchObject({ tab: "to_reconcile" });
  });

  it("shows a dash, not a wrong count, while the list loads", () => {
    useBankTransactions.mockReturnValue({ ...EMPTY, data: undefined, isLoading: true });
    renderPage();
    expect(screen.getByRole("tab", { name: "To reconcile (—)" })).toBeInTheDocument();
  });

  it("no longer carries the old Uncategorized only box", () => {
    renderPage();
    expect(screen.queryByText("Uncategorized only")).not.toBeInTheDocument();
  });

  it("reads in Spanish", () => {
    setLanguage("es");
    renderPage();
    expect(screen.getByRole("tab", { name: "Por conciliar (4)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Conciliados (12)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Todos" })).toBeInTheDocument();
  });
});


describe("BankTransactions in Spanish", () => {
  const row = {
    id: 5, posted_at: "2026-10-03T12:00:00", description: "REMOTE DEPOSIT FEE",
    account_id: 1, account_label: "MSB ••0230", category_slug: "",
    amount: -2.5, amount_cents: -250, booked_on: null,
  };

  beforeEach(() => {
    syncBankTransactions.mockReset();
    useBankTransactions.mockReset();
    useBankTransactions.mockReturnValue({
      ...EMPTY,
      data: { ...EMPTY.data, rows: [row], total: 1, uncategorized_count: 1, page_total_cents: -250 },
    });
  });

  it("the filters, columns and row controls read in Spanish", () => {
    setLanguage("es");
    renderPage();
    expect(screen.getByRole("heading", { name: "Movimientos bancarios" })).toBeInTheDocument();
    expect(screen.getByText("1 movimientos · 1 sin categoría")).toBeInTheDocument();
    for (const name of ["Fecha", "Descripción", "Cuenta", "Categoría", "Monto"]) {
      expect(screen.getByRole("columnheader", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole("option", { name: "— sin categoría —" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear una regla" })).toBeInTheDocument();
    expect(screen.getByText(/Total de la página/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["bankTxn."])).toEqual([]);
  });

  it("a sync reports in Spanish, one or many", async () => {
    setLanguage("es");
    syncBankTransactions.mockResolvedValue({ new_rows: 1 });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar movimientos" }));
    expect(await screen.findByText("Se sincronizó 1 movimiento nuevo.")).toBeInTheDocument();
  });

  it("the make-a-rule popup and its form read in Spanish", async () => {
    setLanguage("es");
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Crear una regla" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Crear una regla con este movimiento" })).toBeInTheDocument();
    expect(within(dialog).getByText("Si")).toBeInTheDocument();
    expect(within(dialog).getByText("Entonces")).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "contiene" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Crear regla" })).toBeInTheDocument();
    expect(englishLeftovers(dialog, ["bankTxn.", "ruleForm.", "rule."])).toEqual([]);
  });
});

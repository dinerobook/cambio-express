import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ReturnCheckBatches from "./ReturnCheckBatches";
import ReturnCheckBatch from "./ReturnCheckBatch";
import ReturnCheckBatchForm from "./ReturnCheckBatchForm";
import ReturnCheckParties from "./ReturnCheckParties";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";
import { TEST_ADMIN } from "../test/setup";

// Returned batches and the By company / By customer lists: what each
// page asks the server for, what it shows, the New batch form's body,
// editing / deleting a batch (asks first), who sees which control, and
// every page in Spanish with no English left over.

const useReturnCheckBatches = vi.fn();
const useReturnCheckBatch = vi.fn();
const useReturnCheckParties = vi.fn();
const createReturnCheckBatch = vi.fn();
const updateReturnCheckBatch = vi.fn();
const deleteReturnCheckBatch = vi.fn();

vi.mock("../api/returnChecks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/returnChecks")>();
  return {
    ...real,
    useReturnCheckBatches: (q: unknown) => useReturnCheckBatches(q),
    useReturnCheckBatch: (id: unknown) => useReturnCheckBatch(id),
    useReturnCheckParties: (q: unknown, enabled?: boolean) => useReturnCheckParties(q, enabled),
    createReturnCheckBatch: (...a: unknown[]) => createReturnCheckBatch(...a),
    updateReturnCheckBatch: (...a: unknown[]) => updateReturnCheckBatch(...a),
    deleteReturnCheckBatch: (...a: unknown[]) => deleteReturnCheckBatch(...a),
  };
});

const BATCH = {
  id: 7, returned_on: "2026-11-10", reference: "RTN-77", notes: "Chase notice",
  check_count: 2, amount_total: 550, fee_total: 25, recovered_total: 100,
  open_count: 1, companies: ["Acme LLC", "Beta Corp"],
};

const CHECK = {
  id: 31, bounced_on: "2026-11-10", customer_name: "Ana Lopez",
  company_name: "Acme LLC", check_number: "1001", payer_bank: "Chase",
  amount: 400, return_check_fee: 25, status: "pending", status_changed_on: "",
  notes: "", recovered_total: 100, payment_count: 1, batch_id: 7,
  batch_reference: "RTN-77", routing_number: "021000021", account_number: "",
};

const PARTY = {
  key: "acme llc", name: "Acme LLC", check_count: 3, amount_total: 1200,
  owed_total: 425, open_count: 1, lost_count: 1, lost_total: 300,
  last_returned_on: "2026-11-10", routing_number: "021000021",
};

const ok = (data: unknown) => ({
  data, isLoading: false, isError: false, error: null, refetch: vi.fn(), isFetching: false,
});

function Probe() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string, route: string, page: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={<>{page}<Probe /></>} />
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  for (const f of [
    useReturnCheckBatches, useReturnCheckBatch, useReturnCheckParties,
    createReturnCheckBatch, updateReturnCheckBatch, deleteReturnCheckBatch,
  ]) f.mockReset();
  useReturnCheckBatches.mockReturnValue(ok({ rows: [BATCH], total: 1, page: 1, total_pages: 1 }));
  useReturnCheckBatch.mockReturnValue(ok({ batch: BATCH, checks: [CHECK] }));
  useReturnCheckParties.mockReturnValue(ok({ rows: [PARTY], total: 1, page: 1, total_pages: 1 }));
});

describe("Batches list", () => {
  it("shows each batch's totals and opens it", async () => {
    renderAt("/return-checks/batches", "/return-checks/batches", <ReturnCheckBatches />);
    expect(useReturnCheckBatches).toHaveBeenLastCalledWith(
      { q: "", sort: "returned", dir: "desc", page: 1, perPage: 50 },
    );
    const row = screen.getByText("RTN-77").closest("tr")!;
    expect(row).toHaveTextContent("Nov 10, 2026");
    expect(row).toHaveTextContent("Acme LLC, Beta Corp");
    expect(row).toHaveTextContent("$550.00");
    expect(row).toHaveTextContent("$100.00");
    expect(within(row).getByText("1 open")).toBeInTheDocument();
    expect(screen.getByText("1 batch")).toBeInTheDocument();
    await userEvent.click(screen.getByText("RTN-77"));
    expect(screen.getByTestId("where")).toHaveTextContent("/return-checks/batches/7");
  });

  it("searches as you type", async () => {
    renderAt("/return-checks/batches", "/return-checks/batches", <ReturnCheckBatches />);
    await userEvent.type(screen.getByLabelText("Search"), "rtn");
    await waitFor(() => expect(useReturnCheckBatches).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "rtn" }),
    ));
  });

  it("explains batches when there are none", () => {
    useReturnCheckBatches.mockReturnValue(ok({ rows: [], total: 0, page: 1, total_pages: 1 }));
    renderAt("/return-checks/batches", "/return-checks/batches", <ReturnCheckBatches />);
    expect(screen.getByText("No batches yet.")).toBeInTheDocument();
    expect(screen.getByText(/add them together with New batch/)).toBeInTheDocument();
  });

  it("shows the error with a retry", () => {
    useReturnCheckBatches.mockReturnValue({
      data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn(),
    });
    renderAt("/return-checks/batches", "/return-checks/batches", <ReturnCheckBatches />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("New batch", () => {
  const page = () => renderAt(
    "/return-checks/batches/new", "/return-checks/batches/new", <ReturnCheckBatchForm />,
  );

  async function fillCheck(n: number, customer: string, company: string, amount: string) {
    const row = screen.getByRole("group", { name: `Check ${n}` });
    await userEvent.type(within(row).getByLabelText("Customer name"), customer);
    await userEvent.type(within(row).getByLabelText("Company name"), company);
    await userEvent.type(within(row).getByLabelText(/^Amount/), amount);
    return row;
  }

  it("saves the batch and every check in one request, then opens the batch", async () => {
    createReturnCheckBatch.mockResolvedValue({ batch: { ...BATCH, id: 12 }, checks: [CHECK, CHECK] });
    page();
    const save = screen.getByRole("button", { name: "Save batch" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Bank reference/), "RTN-90");
    const first = await fillCheck(1, "Ana Lopez", "Acme LLC", "400");
    await userEvent.type(within(first).getByLabelText("Routing # (optional)"), "021-000-021");
    expect(save).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "+ Add another check" }));
    expect(save).toBeDisabled();
    await fillCheck(2, "Luis Perez", "Beta Corp", "150");
    expect(screen.getByText("2 checks · $550.00")).toBeInTheDocument();
    await userEvent.click(save);
    await waitFor(() => expect(createReturnCheckBatch).toHaveBeenCalledTimes(1));
    const body = createReturnCheckBatch.mock.calls[0][0];
    expect(body.reference).toBe("RTN-90");
    expect(body.returned_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.checks).toEqual([
      expect.objectContaining({
        customer_name: "Ana Lopez", company_name: "Acme LLC", amount: 400,
        routing_number: "021000021", return_check_fee: 0, notes: "",
      }),
      expect.objectContaining({ customer_name: "Luis Perez", company_name: "Beta Corp", amount: 150 }),
    ]);
    expect(await screen.findByText("Batch saved with 2 checks.")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/return-checks/batches/12");
  });

  it("removes a check row", async () => {
    page();
    expect(screen.queryByRole("button", { name: "Remove check 1" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "+ Add another check" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove check 2" }));
    expect(screen.queryByRole("group", { name: "Check 2" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal and stays", async () => {
    createReturnCheckBatch.mockRejectedValue(new ApiError(422, "Amount must be positive.", undefined));
    page();
    await fillCheck(1, "Ana", "Acme", "10");
    await userEvent.click(screen.getByRole("button", { name: "Save batch" }));
    expect(await screen.findByText("Amount must be positive.")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/return-checks/batches/new");
  });

  it("asks before leaving with unsaved checks", async () => {
    page();
    await userEvent.type(screen.getByLabelText("Customer name"), "Ana");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/unsaved edits on this batch/)).toBeInTheDocument();
  });

  it("suggests names this store already used", async () => {
    useReturnCheckParties.mockReturnValue(ok({
      rows: [{ ...PARTY, name: "Acme LLC" }], total: 1, page: 1, total_pages: 1,
    }));
    page();
    await userEvent.type(screen.getByLabelText("Company name"), "ac");
    await waitFor(() => expect(useReturnCheckParties).toHaveBeenLastCalledWith(
      expect.objectContaining({ by: "company", q: "ac", perPage: 8 }), true,
    ));
    const input = screen.getByLabelText("Company name");
    const list = document.getElementById(input.getAttribute("list")!)!;
    expect([...list.querySelectorAll("option")].map((o) => o.value)).toEqual(["Acme LLC"]);
  });
});

describe("One batch", () => {
  const page = () => renderAt(
    "/return-checks/batches/7", "/return-checks/batches/:id", <ReturnCheckBatch />,
  );

  it("shows what it adds up to and its checks", () => {
    page();
    expect(useReturnCheckBatch).toHaveBeenLastCalledWith(7);
    expect(screen.getByRole("heading", { name: "Nov 10, 2026 · RTN-77" })).toBeInTheDocument();
    expect(screen.getByText("2 checks returned together")).toBeInTheDocument();
    expect(screen.getByText("$550.00")).toBeInTheDocument();
    // Still owed = open check's face + fee − recovered.
    expect(screen.getByText("$325.00")).toBeInTheDocument();
    const row = screen.getByText("Ana Lopez").closest("tr")!;
    expect(within(row).getByText("Pending")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+ Add check" }))
      .toHaveAttribute("href", "/return-checks/new?batch=7");
    // A batch with checks cannot be deleted.
    expect(screen.queryByRole("button", { name: "Delete batch" })).not.toBeInTheDocument();
  });

  it("saves new batch details", async () => {
    updateReturnCheckBatch.mockResolvedValue({ batch: BATCH, checks: [CHECK] });
    page();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    const ref = screen.getByLabelText(/^Bank reference/);
    await userEvent.clear(ref);
    await userEvent.type(ref, "RTN-78");
    await userEvent.click(save);
    await waitFor(() => expect(updateReturnCheckBatch).toHaveBeenCalledWith(7, {
      returned_on: "2026-11-10", reference: "RTN-78", notes: "Chase notice",
    }));
    expect(await screen.findByText("Batch updated.")).toBeInTheDocument();
  });

  it("deletes an empty batch after asking", async () => {
    useReturnCheckBatch.mockReturnValue(ok({ batch: { ...BATCH, check_count: 0 }, checks: [] }));
    deleteReturnCheckBatch.mockResolvedValue({ ok: true });
    page();
    expect(screen.getByText("No checks in this batch.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete batch" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete this batch?")).toBeInTheDocument();
    expect(deleteReturnCheckBatch).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete batch" }));
    await waitFor(() => expect(deleteReturnCheckBatch).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/return-checks/batches"));
  });

  it("a reader sees the batch but no add, save or delete", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee", permissions: ["return_checks.read"] });
    useReturnCheckBatch.mockReturnValue(ok({ batch: { ...BATCH, check_count: 0 }, checks: [] }));
    page();
    expect(screen.queryByRole("link", { name: "+ Add check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete batch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("a missing batch shows the error with a retry", () => {
    useReturnCheckBatch.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(404, "Returned batch not found", undefined), refetch: vi.fn(), isFetching: false,
    });
    page();
    expect(screen.getByText("Returned batch not found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("By company / By customer", () => {
  it("lists companies with how often and how much, and opens their checks", async () => {
    renderAt("/return-checks/companies", "/return-checks/companies", <ReturnCheckParties by="company" />);
    expect(useReturnCheckParties).toHaveBeenLastCalledWith(
      { by: "company", q: "", from: "", to: "", sort: "checks", dir: "desc", page: 1, perPage: 50 },
      undefined,
    );
    const row = screen.getByText("Acme LLC").closest("tr")!;
    expect(row).toHaveTextContent("021000021");
    expect(row).toHaveTextContent("$1,200.00");
    expect(row).toHaveTextContent("$425.00");
    expect(row).toHaveTextContent("$300.00");
    expect(row).toHaveTextContent("Nov 10, 2026");
    expect(screen.getByText("1 company with returned checks")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Acme LLC"));
    expect(screen.getByTestId("where")).toHaveTextContent("/return-checks?company=acme+llc");
  });

  it("customers: search, period and sort go to the server", async () => {
    renderAt("/return-checks/customers?from=2026-11-01", "/return-checks/customers",
      <ReturnCheckParties by="customer" />);
    expect(useReturnCheckParties).toHaveBeenLastCalledWith(
      expect.objectContaining({ by: "customer", from: "2026-11-01" }), undefined,
    );
    expect(screen.getByRole("button", { name: /^Customer/ })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search"), "ana");
    await waitFor(() => expect(useReturnCheckParties).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "ana" }), undefined,
    ));
    await userEvent.click(screen.getByRole("button", { name: /Still owed/ }));
    expect(useReturnCheckParties).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "owed", dir: "desc" }), undefined,
    );
    await userEvent.click(screen.getByText("Acme LLC"));
    expect(screen.getByTestId("where")).toHaveTextContent("/return-checks?customer=acme+llc");
  });
});

describe("returned checks tracking in Spanish", () => {
  const AREAS = ["returnCheck.", "batch.", "common.", "transfer.status", "unsaved."];
  beforeEach(() => setLanguage("es"));

  it("batches list", () => {
    renderAt("/return-checks/batches", "/return-checks/batches", <ReturnCheckBatches />);
    expect(screen.getByRole("heading", { name: "Cheques devueltos" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Lotes" })).toBeInTheDocument();
    expect(screen.getByText("1 abierto")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("new batch", () => {
    renderAt("/return-checks/batches/new", "/return-checks/batches/new", <ReturnCheckBatchForm />);
    expect(screen.getByRole("heading", { name: "Nuevo lote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar lote" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("one batch", () => {
    renderAt("/return-checks/batches/7", "/return-checks/batches/:id", <ReturnCheckBatch />);
    expect(screen.getByText("Pendiente de cobro")).toBeInTheDocument();
    expect(screen.getByText("2 cheques devueltos juntos")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("by company", () => {
    renderAt("/return-checks/companies", "/return-checks/companies", <ReturnCheckParties by="company" />);
    expect(screen.getByText("1 compañía con cheques devueltos")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Dashboard from "./Dashboard";
import Customers from "./Customers";
import Batches from "./Batches";
import BatchForm from "./BatchForm";
import ReturnChecks from "./ReturnChecks";
import ReturnCheckForm from "./ReturnCheckForm";
import NotFound from "./NotFound";
import StoreGate from "../components/StoreGate";
import { ImpersonationBannerView } from "../components/ImpersonationBanner";
import { ToastProvider } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";
import { TEST_ADMIN } from "../test/setup";
import type { AdminDashboard, EmployeeDashboard } from "../api/dashboard";

// Step 4a in Spanish (UI-STANDARDS §10): the dashboards, customers,
// ACH batches, returned checks and the shared shell pieces show no
// English words of their own; stored values (a batch's "Cleared", a
// check's "pending") read in Spanish while names and money stay as
// typed. English is covered by each page's own tests, unchanged.

const AREAS = [
  "dash.", "customer.", "batch.", "returnCheck.", "register.", "gate.",
  "impersonation.", "notFound.", "common.", "transfer.status", "unsaved.",
];

const useDashboardSummary = vi.fn();
const useCustomerSearch = vi.fn();

vi.mock("react-chartjs-2", () => ({ Line: () => <div data-testid="chart" /> }));

vi.mock("../api/dashboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dashboard")>();
  return { ...real, useDashboardSummary: () => useDashboardSummary() };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, useStoreInfo: () => ({ data: undefined }) };
});

vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return { ...real, useCustomerSearch: (q: string) => useCustomerSearch(q) };
});

const BATCH = {
  id: 4, ach_date: "2026-10-05", company: "Intermex", batch_ref: "R-77",
  ach_amount: 900, transfers_total: 1000, transfer_count: 3,
  card_credit: 50, payout_credit: 25, variance: -25, status: "Cleared",
  reconciled: true, notes: "", transfer_dates: "", expected_ach: 925,
  card_credit_from: "R-70", card_credit_next: 40, payout_credit_next: 10,
  card_credit_next_to: "",
};

const BATCH_DETAIL = { data: { batch: BATCH }, isLoading: false, isError: false };
const NO_DETAIL = { data: undefined, isLoading: false, isError: false };

vi.mock("../api/batches", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/batches")>();
  return {
    ...real,
    useBatches: () => ({
      data: { rows: [BATCH], total: 1, page: 1, total_pages: 1 },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    }),
    // Stable objects: the form hydrates from these in an effect.
    useBatch: (id: number | undefined) => (id ? BATCH_DETAIL : NO_DETAIL),
  };
});

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useTransferChoices: () => ({
      data: { companies: ["Intermex"], countries: ["Mexico"], federal_tax_rate: 0.01 },
      isLoading: false, isError: false, refetch: vi.fn(),
    }),
  };
});

const CHECK = {
  id: 9, bounced_on: "2026-10-01", customer_name: "Ana Ruiz",
  company_name: "Taller Ruiz", check_number: "1001", payer_bank: "Chase",
  amount: 300, return_check_fee: 25, recovered_total: 100, payment_count: 1,
  status: "pending", notes: "",
};

const CHECK_DETAIL = {
  data: { return_check: CHECK }, isLoading: false, isError: false,
  isFetching: false, refetch: vi.fn(),
};
const CHECK_PAYMENTS = {
  data: { payments: [
    { id: 1, paid_on: "2026-10-03", amount: 100, method: "money_order", notes: "" },
  ] },
  isLoading: false,
};

vi.mock("../api/returnChecks", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/returnChecks")>();
  return {
    ...real,
    useReturnChecks: () => ({
      data: { rows: [CHECK], total: 1, page: 1, total_pages: 1 },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
    }),
    useReturnCheck: () => CHECK_DETAIL,
    useReturnCheckPayments: () => CHECK_PAYMENTS,
    useReturnCheckBatches: () => ({ data: { rows: [], total: 0, page: 1, total_pages: 1 } }),
    useReturnCheckBatch: () => ({ data: undefined }),
    useReturnCheckParties: () => ({ data: undefined }),
  };
});

const ADMIN_DASH = {
  role: "admin", today: "2026-11-05", modules: ["module_money_services"],
  sales: {
    today: 500, yesterday: 400, month_to_date: 2000, d7: 1, d15: 2, d30: 3,
    trend: [], hourly: null,
  },
  purchases: { today: 1, d7: 2, d15: 3, d30: 4, open_count: 2, open_total: 80 },
  day_close: {
    date: "2026-11-04", closes: 2, gross_sales: 900, over_short: -3, sales_tax: 5,
    uncounted_drawers: 1, top_departments: [{ name: "Bebidas", amount: 300 }],
  },
  lottery: { date: "2026-11-04", active_packs: 4, tickets_sold: 12, uncounted_active_packs: 0, value: 60 },
  clocked_in: [{ name: "Rosa", clock_in_at: "2026-11-05T14:00:00" }],
  stripe_accounts: [],
  kpis: {
    net_income_month: 1200, pending_ach: 1, today_report_entered: false,
    today_transfers: 2, total_transfers: 40,
  },
  company_stats: [{ company: "Intermex", count: 3, total: 600, fees: 15 }],
  recent_transfers: [{
    id: 1, send_date: "2026-11-05", sender_name: "Maria Lopez",
    company: "Intermex", send_amount: 100, status: "Sent",
  }],
  recent_batches: [{ id: 4, ach_date: "2026-11-03", company: "Maxi", ach_amount: 500, variance: 0, status: "Cleared" }],
  recent_receipts: [{
    id: 3, transaction_no: "T-3", cashier_id: "C1", register_id: "R1",
    total: 12.5, has_voided_line: true, receipt_at: null, business_date: "2026-11-05",
  }],
  register: {
    date: "2026-11-05", is_today: true, receipts: 30, total_rung: 800,
    voided_tickets: 2, refunds: 1, fuel_gallons: 0, fuel_sales: 0,
  },
  transfers_rollup: { today: 1, d7: 2, d15: 3, d30: 4 },
} as unknown as AdminDashboard;

const EMPLOYEE_DASH = {
  role: "employee", today: "2026-11-05", modules: ["module_money_services"],
  day_close: null, lottery: null, register: null,
  today_transfers: [{
    id: 1, created_at: null, sender_name: "Ana", company: "Intermex",
    service_type: "Money Transfer", payment_method: "cash", send_amount: 100,
    fee: 5, recipient_name: "Luis", country: "Mexico", confirm_number: "C1",
    status: "Pending",
  }],
  totals: { sent: 100, paid_out: 0, fees: 5, count: 1 },
} as unknown as EmployeeDashboard;

function renderAt(path: string, route: string, page: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={route} element={page} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({
  data, isLoading: false, isError: false, error: null, refetch: vi.fn(),
});

describe("step 4a screens in Spanish", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    useCustomerSearch.mockReturnValue({
      data: {
        matches: [{ id: 1, full_name: "Ana Ruiz", phone_country: "+1", phone_number: "5551112222",
                    dob: "", address: "", home_store_name: "" }],
        suggestions: [],
      },
      isFetching: false, isError: false, error: null, refetch: vi.fn(),
    });
    setLanguage("es");
  });

  it("the admin dashboard", () => {
    useDashboardSummary.mockReturnValue(ok(ADMIN_DASH));
    renderAt("/dashboard", "/dashboard", <Dashboard />);
    expect(screen.getByRole("heading", { name: "Panel" })).toBeInTheDocument();
    expect(screen.getByText("Ventas de hoy")).toBeInTheDocument();
    expect(screen.getByText("1 caja sin contar")).toBeInTheDocument();
    expect(screen.getByText("12 boletos vendidos")).toBeInTheDocument();
    expect(screen.getByText("Ventas (nov hasta hoy)")).toBeInTheDocument();
    // Stored statuses read in Spanish; names stay as typed.
    expect(screen.getByText("Enviado")).toBeInTheDocument();
    expect(screen.getByText("Acreditado")).toBeInTheDocument();
    expect(screen.getByText("3 envíos")).toBeInTheDocument();
    expect(screen.getByText("Bebidas")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the employee dashboard", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee" });
    useDashboardSummary.mockReturnValue(ok(EMPLOYEE_DASH));
    renderAt("/dashboard", "/dashboard", <Dashboard />);
    expect(screen.getByRole("heading", { name: "Mi panel" })).toBeInTheDocument();
    expect(screen.getByText("Pendiente")).toBeInTheDocument();
    expect(screen.getByText("Total enviado hoy:")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("customers, with the merge banner and popup", async () => {
    const user = userEvent.setup();
    renderAt("/customers?q=an", "/customers", <Customers />);
    expect(screen.getByText("1 coincidencia · 0 sugerencias")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unir duplicados" }));
    expect(screen.getByText("Modo de unión")).toBeInTheDocument();
    await user.click(screen.getByText("Seleccionar a Ana Ruiz para unir"));
    expect(screen.getByText(/se queda\); elija uno más/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the ACH batch list and form", () => {
    renderAt("/batches", "/batches", <Batches />);
    expect(screen.getByRole("heading", { name: "Lotes ACH" })).toBeInTheDocument();
    expect(screen.getByText("1 lote")).toBeInTheDocument();
    expect(screen.getByText("Acreditado")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the ACH batch edit form and its credit note", () => {
    renderAt("/batches/4/edit", "/batches/:id/edit", <BatchForm />);
    expect(screen.getByRole("heading", { name: "Editar lote #4" })).toBeInTheDocument();
    const status = screen.getByLabelText("Estado");
    expect(within(status).getByRole("option", { name: "Acreditado" })).toHaveValue("Cleared");
    // Both credits on one batch: one whole sentence, plural verb.
    expect(screen.getByText(
      "$40.00 pagados con tarjeta de débito y $10.00 pagados a beneficiarios en este lote "
      + "se acreditan en el próximo ACH de esta compañía, cuando se registre.",
    )).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("returned checks: list, edit page and payment methods", () => {
    renderAt("/return-checks", "/return-checks", <ReturnChecks />);
    expect(screen.getByRole("heading", { name: "Cheques devueltos" })).toBeInTheDocument();
    expect(screen.getByText("1 cheque en total")).toBeInTheDocument();
    expect(screen.getAllByText("Pendiente").length).toBeGreaterThan(0);
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("a returned check's edit page", () => {
    renderAt("/return-checks/9/edit", "/return-checks/:id/edit", <ReturnCheckForm />);
    expect(screen.getByRole("heading", { name: "Cheque devuelto #9" })).toBeInTheDocument();
    expect(screen.getByText(/Recuperado/).textContent).toBe("Recuperado $100.00 de $325.00");
    // A stored method reads in Spanish in the table and the picker.
    expect(screen.getAllByText("Giro postal").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Marcar como pérdida" })).toBeInTheDocument();
    // It has payments, so Delete waits and says why, in Spanish.
    expect(screen.getByText("Para eliminar este cheque, primero quite sus pagos.")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the shell pieces: store gate, impersonation bar, 404", () => {
    render(
      <MemoryRouter>
        <StoreGate reason="frozen" storeName="La Mar" onSignOut={() => {}} />
        <ImpersonationBannerView
          actingAs="Ana" role="admin" storeName="La Mar" byName="Dana" onExit={() => {}}
        />
        <NotFound />
      </MemoryRouter>,
    );
    expect(screen.getByText("Cuenta suspendida")).toBeInTheDocument();
    expect(screen.getByText("La Mar", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Esa página todavía no existe.")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });
});

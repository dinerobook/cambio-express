import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import DailyBook from "./DailyBook";
import type {
  LineItemRow, MTBreakdownRow, OpenSettlement,
} from "../api/dailybook";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";
import { TEST_ADMIN } from "../test/setup";

// The daily book in Spanish (UI-STANDARDS §10): the month calendar,
// the day editor and every box's popup show no English words of
// their own, a server error the cashier can hit reads in Spanish, and
// the figures and what people typed stay as they are. English is
// covered by every other EditDailyBook / DailyBook test, unchanged.

const DAY = "2026-10-06";
const AREAS = ["daily.", "calendar.", "period.", "common.", "unsaved."];

const useDailyReport = vi.fn();
const useOpenSettlements = vi.fn();
const updateDailyReport = vi.fn();
const deleteLineItem = vi.fn();
const useDailyPeriod = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => LINES,
    useMTBreakdown: () => MT,
    useOpenSettlements: () => useOpenSettlements(),
    updateDailyReport: (...a: unknown[]) => updateDailyReport(...a),
    deleteLineItem: (...a: unknown[]) => deleteLineItem(...a),
    useDailyPeriod: (...a: unknown[]) => useDailyPeriod(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

const row = (over: Partial<LineItemRow>): LineItemRow => ({
  id: 1, kind: "other_cash_out", at_time: "", amount: 0, note: "",
  return_check_id: null, expects_settlement: false, settle_by: null,
  settled: 0, settles_item_id: null, ...over,
});

const mtRow = (company: string, amount: number): MTBreakdownRow => ({
  company, saved_amount: amount, saved_fees: 0, saved_federal_tax: 0,
  saved_commission: 0, auto_amount: 0, auto_fees: 0, auto_federal_tax: 0,
  auto_commission: 0, auto_count: 0, auto_total: 0, saved_total: amount,
} as MTBreakdownRow);

// Stable objects: the page syncs drafts from these in effects.
const LINES = {
  data: {
    items: [
      row({ id: 1, amount: 2000, note: "Tienda 2", expects_settlement: true, settled: 500 }),
      row({ id: 2, kind: "cash_purchase", amount: 40, note: "Hielo", at_time: "09:30" }),
      row({ id: 3, kind: "drop", amount: 900, in_bank: "added", bank_date: DAY }),
    ],
  },
};
const MT = {
  data: {
    rows: [mtRow("Intermex", 800)], services: [], saved_total: 800,
    auto_total: 0, money_order_companies: ["Intermex"],
  },
  isLoading: false, isFetching: false,
};
const STORE_INFO = { data: { store: { sales_tax_rate: 0.0825 } } };
const SESSION = { data: undefined };

const owed = (over: Partial<OpenSettlement>): OpenSettlement => ({
  id: 50, kind: "other_cash_out", report_date: "2026-10-03", amount: 600,
  note: "Prestado a Raj", settle_by: "2026-10-04", settled: 0,
  outstanding: 600, day_locked: true, returns: [], ...over,
} as OpenSettlement);
const OPEN = { data: [owed({})], isError: false };

function savedDay(fields: Record<string, unknown>) {
  const report = new Proxy(
    { locked: false, notes: "", report_date: DAY, ...fields },
    { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
  );
  return { data: report, isLoading: false, isFetching: false };
}

function renderDay() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/daily/edit?date=${DAY}`]}>
        <EditDailyBook />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const tile = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });

async function openBox(name: string): Promise<HTMLElement> {
  await userEvent.click(tile(name));
  return screen.findByRole("dialog");
}


beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  setLanguage("es");
  useDailyReport.mockReturnValue(savedDay({
    taxable_sales: 100, forward_balance_auto: true,
    forward_balance_carry: 250, forward_balance: 250,
  }));
  useOpenSettlements.mockReturnValue(OPEN);
  updateDailyReport.mockReset().mockResolvedValue({});
  deleteLineItem.mockReset().mockResolvedValue({});
});

describe("daily book in Spanish", () => {
  it("shows the day with no English and keeps the figures", () => {
    renderDay();
    expect(screen.getByText("Saldo inicial")).toBeInTheDocument();
    // The trail above the day reads like the sidebar.
    const trail = screen.getByRole("navigation", { name: "Ruta de navegación" });
    expect(within(trail).getByText("Diario")).toBeInTheDocument();
    expect(within(trail).getByText("Libro diario MSB")).toBeInTheDocument();
    expect(screen.getAllByText("Entradas").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /^Guardar libro diario/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Día anterior" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Volver al calendario" })).toHaveLength(2);
    // Money keeps its US format; the day heading uses Spanish words.
    expect(tile("Ventas")).toHaveTextContent("$100.00");
    expect(screen.getAllByText(/oct/i).length).toBeGreaterThan(0);
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it.each([
    "Ventas", "Comisiones", "Servicios", "Efectivo del banco",
    "Nómina", "Compras", "Gastos", "Depósitos de cheques",
    "Depósitos de efectivo",
  ])("opens the %s box in Spanish", async (name) => {
    renderDay();
    const dialog = await openBox(name);
    expect(dialog).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("sales tax hint reads in Spanish", async () => {
    renderDay();
    const dialog = await openBox("Ventas");
    expect(within(dialog).getByText("Automático: 8.25% de la venta gravable")).toBeInTheDocument();
  });

  it("services table reads in Spanish, company names untouched", async () => {
    renderDay();
    const dialog = await openBox("Servicios");
    expect(within(dialog).getAllByText("Compañía").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Intermex").length).toBeGreaterThan(0);
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Giros postales/ }));
    expect(within(dialog).getByLabelText("Giros postales vendidos de Intermex")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("entries table and the In bank mark read in Spanish", async () => {
    renderDay();
    // "1 entrada" on a single-entry box: plural rules, not "+s".
    expect(tile("Depósitos de efectivo")).toHaveTextContent("1 entrada");
    const dialog = await openBox("Depósitos de efectivo");
    expect(within(dialog).getByText("En el banco")).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "Hora" })).toBeInTheDocument();
  });

  it("money owed: tabs, overdue, and the close popup in Spanish", async () => {
    renderDay();
    expect(within(tile("Entrada de efectivo")).getByText("1 vencidos")).toBeInTheDocument();
    const dialog = await openBox("Entrada de efectivo");
    await userEvent.click(within(dialog).getByRole("tab", { name: /^Nos deben/ }));
    expect(within(dialog).getByText("Prestado a Raj")).toBeInTheDocument();
    expect(within(dialog).getByText(/vencido$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/está cerrado\. Reábralo/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("asks before removing an entry, in Spanish", async () => {
    renderDay();
    const dialog = await openBox("Compras");
    const ice = within(dialog).getByText("Hielo").closest("tr")!;
    await userEvent.click(within(ice).getByRole("button", { name: "Quitar" }));
    expect(await screen.findByText("¿Quitar esta entrada?")).toBeInTheDocument();
    expect(screen.getByText("$40.00 (Hielo) sale del libro de este día.")).toBeInTheDocument();
  });

  it("shows a known server error in Spanish", async () => {
    updateDailyReport.mockRejectedValueOnce(new ApiError(
      409, "Daily report is locked — unlock it before editing.", {},
    ));
    renderDay();
    await userEvent.click(screen.getByRole("button", { name: /^Guardar libro diario/ }));
    expect(await screen.findByText(
      "El libro de este día está cerrado. Reábralo antes de editar.",
    )).toBeInTheDocument();
  });

  it("locked day: pill, note and Reabrir in Spanish", () => {
    useDailyReport.mockReturnValue(savedDay({ locked: true, locked_at: `${DAY}T20:00:00` }));
    renderDay();
    expect(screen.getByText(/^Cerrado · /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reabrir/ })).toBeInTheDocument();
    expect(screen.getByText(/Este día está cerrado/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("month calendar: Spanish month, weekdays, legend and summary", () => {
    useDailyPeriod.mockReturnValue({
      data: {
        rows: [{
          id: 1, store_id: 1, report_date: "2026-10-07",
          total_receipts: 1500, total_disbursements: 500, over_short: -2.5,
          locked: true,
        }],
        total_receipts: 1500, total_disbursements: 500, net: 1000, days_logged: 1,
      },
      isLoading: false, isError: false,
    });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/daily?year=2026&month=10"]}>
          <DailyBook />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("octubre de 2026")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Libro diario MSB" })).toBeInTheDocument();
    expect(screen.getByText("Días anotados")).toBeInTheDocument();
    expect(screen.getByText("Sin entradas todavía")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mes anterior" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir el libro diario del 2026-10-07" }))
      .toBeInTheDocument();
    expect(screen.getAllByText("$1,000").length).toBeGreaterThan(0);
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });
});

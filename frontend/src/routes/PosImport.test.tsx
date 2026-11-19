import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PosImport from "./PosImport";
import type { MovementDay, StagedDay } from "../api/posimport";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Revoking a site-agent key stops that back-office PC uploading
// register journals at once, so it goes through a confirm dialog
// (UI-STANDARDS §2: destructive action = ConfirmDialog). It used
// to fire on the first click.

const revokeAgentKey = vi.fn();
const createAgentPairing = vi.fn();
let stagedDays: StagedDay[] = [];
let movementDay: MovementDay | undefined;
const movementDayFor = vi.fn();

vi.mock("../api/posimport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/posimport")>();
  return {
    ...real,
    revokeAgentKey: (...a: unknown[]) => revokeAgentKey(...a),
    createAgentPairing: () => createAgentPairing(),
    useStagedDays: () => ({ data: { days: stagedDays }, isLoading: false, isError: false }),
    useMovementDay: (day: string) => {
      movementDayFor(day);
      return { data: movementDay, isLoading: false, isError: false };
    },
    useAgentKeys: () => ({
      data: {
        keys: [
          { id: 7, label: "Back office PC", created_at: "2026-10-01T10:00:00Z",
            last_used_at: null, revoked: false },
          { id: 8, label: "Old PC", created_at: "2026-09-01T10:00:00Z",
            last_used_at: null, revoked: true },
        ],
      },
      isLoading: false, isError: false,
    }),
  };
});

vi.mock("../api/dayclose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dayclose")>();
  return {
    ...real,
    useDepartments: () => ({ data: { departments: [] }, isLoading: false, isError: false }),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <PosImport />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PosImport agent key revoke", () => {
  beforeEach(() => {
    revokeAgentKey.mockReset();
    stagedDays = [];
    movementDay = undefined;
  });

  it("offers Revoke only on active keys", () => {
    renderPage();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("asks before revoking and does nothing on cancel", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Revoke "Back office PC"?');
    expect(revokeAgentKey).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(revokeAgentKey).not.toHaveBeenCalled();
  });

  it("revokes the chosen key on confirm", async () => {
    revokeAgentKey.mockResolvedValue({});
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeAgentKey).toHaveBeenCalledWith(7));
    expect(await screen.findByText("Agent key revoked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the server's error on failure", async () => {
    revokeAgentKey.mockRejectedValue(new ApiError(409, "Key already revoked", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    // The open dialog marks the rest of the page aria-hidden, toasts included.
    expect(await screen.findByRole("alert", { hidden: true }))
      .toHaveTextContent("Key already revoked");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reads in Spanish, the revoke popup included", async () => {
    setLanguage("es");
    renderPage();
    expect(screen.getByRole("heading", { name: /Importar de la caja/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elegir archivo…" })).toBeInTheDocument();
    expect(screen.getByText("Todavía no hay subidas del agente")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(expect.arrayContaining(["Nombre", "Creada", "Vista por última vez", "Estado"]));
    expect(screen.getByText("Old PC").closest("tr")).toHaveTextContent("Anulada");
    expect(englishLeftovers(document.body, ["posImp."])).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Anular" }));
    const dialog = await screen.findByRole("dialog", { name: "¿Anular esta clave del agente?" });
    expect(dialog).toHaveTextContent('¿Anular "Back office PC"?');
    expect(englishLeftovers(dialog, ["posImp."])).toEqual([]);
  });
});

// Register reports (G-7): the movement reports staged for a day open
// read-only below the staged list. MSM subtotals are marked and the
// rows they add up are indented, so nobody adds both.

const DAY: MovementDay = {
  day: "2025-12-05",
  files: [
    { family: "FGM", filename: "FGM1.xml", received_at: "2025-12-06T05:00:00", parse_error: "" },
    { family: "MSM", filename: "MSM1.xml", received_at: "2025-12-06T05:00:00", parse_error: "" },
    { family: "ISM", filename: "ISM1.xml", received_at: "2025-12-06T05:00:00",
      parse_error: "ISM: Bad money value 'x' in <SalesAmount>" },
  ],
  fuel: [{ grade_id: "001", gallons: 39.095, amount: 119.62,
           meter_gallons: 42250.35, meter_amount: 101260.6, positions: 2 }],
  departments: [{ merchandise_code: "10", description: "SODA", quantity: 4,
                  amount: 8.46, refunds: 0, transactions: 3 }],
  tax_levels: [{ tax_level_id: "99", taxable_sales: 1520.33, tax_collected: 125.43,
                 tax_exempt_sales: 0, tax_forgiven_sales: 3.1 }],
  misc: [
    { code: "payouts", sub_code: "vendorPay", modifier: null, tender_code: "",
      tender_sub_code: "", amount: -150, count: 3, role: "subtotal" },
    { code: "payouts", sub_code: "vendorPay", modifier: "3", tender_code: "",
      tender_sub_code: "", amount: -100, count: 0, role: "part" },
    { code: "safeDrop", sub_code: "total", modifier: null, tender_code: "cash",
      tender_sub_code: "generic", amount: 800, count: 4, role: "" },
  ],
  item_rows: 3, item_quantity: 10, item_amount: 10.56,
};

const STAGED: StagedDay = {
  business_date: "2025-12-05", file_count: 412, error_count: 0,
  committed: true, report_count: 6,
};

describe("PosImport register reports", () => {
  beforeEach(() => {
    stagedDays = [STAGED, { ...STAGED, business_date: "2025-12-04", report_count: 0 }];
    movementDay = DAY;
    movementDayFor.mockReset();
    setLanguage("en");
  });

  it("opens a day's reports from its count and closes them again", async () => {
    renderPage();
    const rows = screen.getAllByRole("row");
    const withReports = rows.find((r) => r.textContent?.includes("6 reports"));
    expect(withReports).toBeDefined();
    // A day with no reports has no control, just a dash.
    expect(screen.getAllByRole("button", { name: /reports?$/ })).toHaveLength(1);
    expect(screen.queryByText(/Register reports ·/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "6 reports" }));
    expect(movementDayFor).toHaveBeenCalledWith("2025-12-05");
    expect(screen.getByRole("heading", { name: /Register reports ·/ })).toBeInTheDocument();
    // KPI card + the fuel table row.
    expect(screen.getAllByText("$119.62")).toHaveLength(2);
    expect(screen.getByText("SODA")).toBeInTheDocument();
    expect(screen.getAllByText("$125.43")).toHaveLength(2);
    expect(screen.getByText("cash / generic")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Register reports ·/)).not.toBeInTheDocument();
  });

  it("marks the subtotal and indents the rows it adds up", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "6 reports" }));
    const subtotal = screen.getByText("subtotal").closest("tr");
    expect(subtotal).toHaveTextContent("-150.00");
    const part = screen.getByText("-100.00").closest("tr");
    expect(part).not.toHaveTextContent("subtotal");
    expect(within(part as HTMLElement).getByText("payouts").className).toMatch(/partIndent/);
  });

  it("lists the reports the server could not read", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "6 reports" }));
    expect(screen.getByText("1 report could not be read:")).toBeInTheDocument();
    expect(screen.getByText(/ISM1\.xml: ISM: Bad money value/)).toBeInTheDocument();
  });

  it("says so when the day has no reports", async () => {
    movementDay = { ...DAY, files: [], fuel: [], departments: [], tax_levels: [], misc: [] };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "6 reports" }));
    expect(screen.getByText("No register reports for this day")).toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "6 reportes" }));
    expect(screen.getByRole("heading", { name: /Reportes de la caja ·/ })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(expect.arrayContaining(["Grado", "Galones", "Forma de pago", "Nivel de impuesto"]));
    expect(englishLeftovers(document.body, ["posImp."])).toEqual([]);
  });
});

// Connect a computer: DineroBook Manager on the store PC scans a
// one-time code, so nobody there types a name or a password.

describe("PosImport connect a computer", () => {
  beforeEach(() => {
    setLanguage("en");
    createAgentPairing.mockReset();
    stagedDays = [];
    movementDay = undefined;
  });

  const PAIRING = { code: "K7M4-Q2XP-9HD3", expires_at: "2026-11-19T15:10:00", minutes: 10 };

  it("shows the code as text and as a barcode", async () => {
    createAgentPairing.mockResolvedValue(PAIRING);
    renderPage();
    expect(screen.queryByRole("img", { name: /Barcode/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect a computer" }));
    expect(await screen.findByText("K7M4-Q2XP-9HD3")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Barcode for connect code K7M4-Q2XP-9HD3" })).toBeInTheDocument();
    expect(screen.getByText(/Works once, until/)).toBeInTheDocument();
    // Another click makes a fresh code (the server ends the old one).
    createAgentPairing.mockResolvedValue({ ...PAIRING, code: "ZZZZ-YYYY-XXXX" });
    await userEvent.click(screen.getByRole("button", { name: "Make a new code" }));
    expect(await screen.findByText("ZZZZ-YYYY-XXXX")).toBeInTheDocument();
    expect(createAgentPairing).toHaveBeenCalledTimes(2);
  });

  it("says so when no code could be made", async () => {
    createAgentPairing.mockRejectedValue(new ApiError(403, "Permission denied", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Connect a computer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.queryByRole("img", { name: /Barcode/ })).not.toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    createAgentPairing.mockResolvedValue(PAIRING);
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Conectar una computadora" }));
    expect(await screen.findByRole("img", { name: "Código de barras del código de conexión K7M4-Q2XP-9HD3" })).toBeInTheDocument();
    expect(screen.getByText(/Sirve una vez, hasta las/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["posImp."])).toEqual([]);
  });
});

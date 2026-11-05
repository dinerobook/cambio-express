import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Transfers from "./Transfers";
import NewTransfer from "./NewTransfer";
import EditTransfer from "./EditTransfer";
import TransferDetail from "./TransferDetail";
import TransferReceipt from "./TransferReceipt";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The transfer screens in Spanish (UI-STANDARDS §10): the list, the
// new and edit forms, the detail page with its delete popup and the
// receipt show no English words of their own; form errors and the
// server's refusals read in Spanish; stored values (service, status)
// are shown in Spanish but still sent to the API in English; names,
// companies, countries and money stay exactly as typed. English is
// covered by every other transfer test, unchanged.

const AREAS = ["transfer.", "common.", "unsaved."];

const useTransfers = vi.fn();
const useTransfer = vi.fn();
const createTransfer = vi.fn();
const updateTransfer = vi.fn();
const deleteTransfer = vi.fn();
const storeInfo = vi.fn();

const CHOICES = {
  data: {
    companies: ["Intermex", "Maxi"],
    countries: ["Mexico", "Guatemala", "United States"],
    federal_tax_rate: 0.01,
  },
  isLoading: false, isError: false, refetch: vi.fn(),
};
const EMPLOYEES = {
  data: { employees: [{ id: 7, name: "Rosa Diaz" }] },
  isLoading: false, isError: false,
};

const transfer = {
  id: 12, send_date: "2026-10-03", created_at: "", company: "Intermex",
  service_type: "Money Transfer", payment_method: "cash",
  sender_name: "Maria Lopez", sender_phone: "5551112222",
  sender_phone_country: "+1", sender_address: "", sender_dob: "",
  recipient_name: "Juan Garcia", recipient_phone: "", country: "Mexico",
  confirm_number: "ABC123", send_amount: 1000, fee: 7.5, federal_tax: 10,
  total_collected: 1017.5, status: "Sent", batch_id: "B1",
  employee_name: "Rosa Diaz", employee_id: 7, customer_id: null,
  commission: 0, status_notes: "", internal_notes: "",
};

const receipt = {
  store: {
    name: "Casa Cambio", address: "1 Main St", phone: "555-0100",
    email: "hi@casa.test", receipt_logo_url: "", receipt_footer: "",
    receipt_tax_id: "99-123",
  },
  transfer,
};

vi.mock("../api/transfers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/transfers")>();
  return {
    ...real,
    useTransfers: (...a: unknown[]) => useTransfers(...a),
    useTransfer: (...a: unknown[]) => useTransfer(...a),
    useTransferReceipt: () => ({
      data: receipt, isLoading: false, isError: false, refetch: vi.fn(),
    }),
    useTransferChoices: () => CHOICES,
    useEmployees: () => EMPLOYEES,
    createTransfer: (...a: unknown[]) => createTransfer(...a),
    updateTransfer: (...a: unknown[]) => updateTransfer(...a),
    deleteTransfer: (...a: unknown[]) => deleteTransfer(...a),
  };
});

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return { ...real, useStoreInfo: () => storeInfo() };
});

vi.mock("../api/customers", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/customers")>();
  return {
    ...real,
    useCustomerSearch: () => ({ data: undefined, isFetching: false }),
  };
});

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

describe("transfer screens in Spanish", () => {
  beforeEach(() => {
    useTransfers.mockReset();
    useTransfer.mockReset();
    createTransfer.mockReset();
    updateTransfer.mockReset();
    deleteTransfer.mockReset();
    storeInfo.mockReturnValue({ data: undefined, isError: true });
    useTransfers.mockReturnValue({
      data: {
        rows: [
          transfer,
          { ...transfer, id: 13, service_type: "Payout", status: "Pending",
            sender_name: "Ana Ruiz", payment_method: "cash" },
        ],
        total: 1234, page: 1, per_page: 50, total_pages: 25, page_amount: 0,
      },
      dataUpdatedAt: Date.now(), isLoading: false, isFetching: false,
      isError: false, error: null, refetch: vi.fn(),
    });
    useTransfer.mockReturnValue({
      data: { transfer }, isLoading: false, isError: false, refetch: vi.fn(),
    });
    setLanguage("es");
  });

  it("the list: headings, filters, stored values and the count", () => {
    renderAt("/transfers", "/transfers", <Transfers />);
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
    expect(screen.getByRole("heading", { name: "Envíos" })).toBeInTheDocument();
    expect(screen.getByText("1,234 envíos")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Remitente/ })).toBeInTheDocument();
    // Stored values read in Spanish; the filter still sends English.
    const status = screen.getByLabelText("Estado");
    expect(within(status).getByRole("option", { name: "Enviado" }))
      .toHaveValue("Sent");
    expect(screen.getAllByText("Pendiente").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pago a beneficiario").length).toBeGreaterThan(1);
    // What people typed stays as typed.
    expect(screen.getAllByText("Maria Lopez").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Intermex").length).toBeGreaterThan(0);
  });

  it("the new form: its words, its errors, and a payout's names", async () => {
    const user = userEvent.setup();
    renderAt("/transfers/new", "/transfers/new", <NewTransfer />);
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
    const save = screen.getByRole("button", { name: "Guardar envío" });
    save.closest("form")!.noValidate = true;
    await user.click(save);
    expect(await screen.findByText("El monto debe ser mayor que 0"))
      .toBeInTheDocument();
    expect(screen.getByText("Elija un empleado")).toBeInTheDocument();
    expect(createTransfer).not.toHaveBeenCalled();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);

    await user.selectOptions(screen.getByLabelText("Servicio"), "Pago a beneficiario");
    expect(screen.getByText("Beneficiario (pagado aquí)")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Monto pagado/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Comisión/)).not.toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the new form: a server refusal reads in Spanish; the API gets English", async () => {
    createTransfer.mockRejectedValueOnce(new ApiError(
      422,
      "An employee from the store roster must be selected as Processed by before saving.",
      null,
    ));
    const user = userEvent.setup();
    renderAt("/transfers/new", "/transfers/new", <NewTransfer />);
    fireEvent.change(screen.getByLabelText("Fecha"), { target: { value: "2026-10-05" } });
    await user.type(screen.getByLabelText("Nombre completo"), "Maria Lopez");
    await user.type(screen.getByLabelText("Nombre del beneficiario"), "Juan Garcia");
    await user.type(screen.getByLabelText(/^Monto enviado/), "100");
    await user.selectOptions(screen.getByLabelText("Empleado"), "7");
    await user.click(screen.getByRole("button", { name: "Guardar envío" }));
    expect(await screen.findByText(
      "Antes de guardar, elija en «Atendido por» un empleado de la lista de la tienda.",
    )).toBeInTheDocument();
    expect(createTransfer.mock.lastCall![0]).toMatchObject({
      service_type: "Money Transfer", status: "Sent",
    });
  });

  it("the new form: the out-of-hours notice names the day in Spanish", () => {
    const closed = Array.from({ length: 7 }, (_, day) => ({
      day, open: "09:00", close: "17:00", closed: true,
    }));
    storeInfo.mockReturnValue({
      data: { store: { store_hours: closed, timezone: "America/Chicago" } },
    });
    renderAt("/transfers/new", "/transfers/new", <NewTransfer />);
    const notice = screen.getByText(/^Aviso:/);
    expect(notice.textContent).toMatch(
      /cerrado todo el (lunes|martes|miércoles|jueves|viernes|sábado|domingo)/,
    );
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the edit form", async () => {
    renderAt("/transfers/12/edit", "/transfers/:id/edit", <EditTransfer />);
    expect(await screen.findByRole("heading", { name: "Editar envío #12" }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar cambios" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
  });

  it("the detail page and its delete popup", async () => {
    const user = userEvent.setup();
    renderAt("/transfers/12", "/transfers/:id", <TransferDetail />);
    expect(screen.getByRole("heading", { name: "Envío #12" })).toBeInTheDocument();
    expect(screen.getByText("Estado y referencias")).toBeInTheDocument();
    expect(screen.getByText("Enviado")).toBeInTheDocument();
    expect(screen.getByText(/Envío de dinero/)).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Eliminar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("¿Eliminar el envío #12?")).toBeInTheDocument();
    expect(dialog.textContent).toContain("Maria Lopez → Juan Garcia, $1,017.50 cobrado el");
    expect(englishLeftovers(dialog, AREAS)).toEqual([]);

    deleteTransfer.mockRejectedValueOnce(new ApiError(404, "Transfer not found", null));
    await user.click(within(dialog).getByRole("button", { name: "Eliminar envío" }));
    await waitFor(() => {
      expect(within(dialog).getByText("No se encontró el envío")).toBeInTheDocument();
    });
  });

  it("the receipt", () => {
    renderAt("/transfers/12/receipt", "/transfers/:id/receipt", <TransferReceipt />);
    expect(screen.getByRole("button", { name: "Imprimir recibo" })).toBeInTheDocument();
    expect(screen.getByText("ID fiscal: 99-123")).toBeInTheDocument();
    expect(screen.getByText("Cajero (Rosa Diaz)")).toBeInTheDocument();
    expect(englishLeftovers(document.body, AREAS)).toEqual([]);
    // The money still reads once and adds up.
    expect(screen.getAllByText("$1,017.50").length).toBeGreaterThan(0);
  });
});

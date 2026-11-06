import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminDataExport from "./AdminDataExport";
import { setLanguage } from "../i18n";
import { mockFetch } from "../test/fetchMock";
import { englishLeftovers } from "../test/i18n";
import { renderRoute } from "../test/renderRoute";

// The data export hub: one card per download, each with its own
// busy state and its own error line. (Which cards an accountant sees
// is pinned in lib/accountant.test.tsx.)

const downloadCsv = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  downloadCsv: (...a: unknown[]) => downloadCsv(...a),
}));

function routes() {
  return {
    "GET /api/v2/admin/tax-export/years": { body: { years: [2026, 2025], default_year: 2025 } },
  };
}

function card(title: string): HTMLElement {
  return screen.getByText(title).closest("section") as HTMLElement;
}

describe("Data export", () => {
  beforeEach(() => { downloadCsv.mockReset().mockResolvedValue(undefined); });

  it("downloads the tax pack for the picked year", async () => {
    mockFetch(routes());
    const user = userEvent.setup();
    renderRoute(<AdminDataExport />);
    const tax = card("Year-end tax pack (ZIP)");
    await screen.findByRole("option", { name: "2026" });
    await user.selectOptions(within(tax).getByLabelText("Year"), "2026");
    await user.click(within(tax).getByRole("button", { name: "Download ZIP" }));
    expect(downloadCsv).toHaveBeenCalledWith(
      "/api/v2/admin/tax-export.zip?year=2026", "tax-pack-2026.zip",
    );
  });

  it("shows a failed download on its own card", async () => {
    downloadCsv.mockRejectedValue(new Error("boom"));
    mockFetch(routes());
    const user = userEvent.setup();
    renderRoute(<AdminDataExport />);
    const customers = card("Customer directory");
    await user.click(within(customers).getByRole("button", { name: "Download CSV" }));
    expect(await within(customers).findByRole("alert")).toBeInTheDocument();
    expect(within(card("Transfers (custom range)")).queryByRole("alert")).toBeNull();
  });
});

describe("Data export in Spanish", () => {
  beforeEach(() => { downloadCsv.mockReset().mockResolvedValue(undefined); });

  it("every card, field and button reads in Spanish", async () => {
    setLanguage("es");
    mockFetch(routes());
    renderRoute(<AdminDataExport />);
    await screen.findByRole("option", { name: "2026" });
    expect(screen.getByRole("heading", { name: "Exportar datos" })).toBeInTheDocument();
    expect(screen.getByText("Paquete de impuestos de fin de año (ZIP)")).toBeInTheDocument();
    expect(screen.getByText("Registros del reloj checador (rango a elegir)")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Descargar CSV" }).length).toBeGreaterThanOrEqual(4);
    expect(screen.getAllByText("Desde").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("/app/reports")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["export."])).toEqual([]);
  });

  it("a failed download says so in Spanish", async () => {
    setLanguage("es");
    downloadCsv.mockRejectedValue(new Error(""));
    mockFetch(routes());
    const user = userEvent.setup();
    renderRoute(<AdminDataExport />);
    const audit = card("Registro de auditoría");
    await user.click(within(audit).getByRole("button", { name: "Descargar CSV" }));
    expect(await within(audit).findByRole("alert")).toHaveTextContent("La descarga falló.");
  });
});

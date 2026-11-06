import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Reports from "./Reports";
import { setLanguage } from "../i18n";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";

// /reports and /store-reports: one page, two registries (the
// ?collection= filter). The title follows the collection; a refused
// list asks for a store sign-in, any other failure offers a retry.

const LIST = {
  categories: [{
    key: "sales", label: "Sales", icon: "<svg></svg>",
    reports: [{
      key: "sales_by_company", label: "Sales by company",
      description: "Volume, fees, and federal tax split between Intermex, Maxi, and Barri.",
      url: "/reports/sales-by-company", status: "ready",
    }],
  }],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("Reports", () => {
  it("asks for the MSB registry and lists it under MSB reports", async () => {
    const calls = mockFetch({ "GET /api/v2/reports": { body: LIST } });
    renderRoute(<Reports />, { path: "/reports" });
    expect(await screen.findByText("Sales by company")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MSB reports" })).toBeInTheDocument();
    expect(calls[0].url.searchParams.get("collection")).toBe("msb");
  });

  it("titles the back-office registry Store reports", async () => {
    const calls = mockFetch({ "GET /api/v2/reports": { body: LIST } });
    renderRoute(<Reports collection="store" />, { path: "/store-reports" });
    expect(await screen.findByRole("heading", { name: "Store reports" })).toBeInTheDocument();
    expect(calls[0].url.searchParams.get("collection")).toBe("store");
  });

  it("asks a refused caller to sign in as a store user, with no retry", async () => {
    mockFetch({ "GET /api/v2/reports": { status: 403, body: { detail: "Forbidden" } } });
    renderRoute(<Reports />, { path: "/reports" });
    expect(await screen.findByText("Sign in as a store user to view reports."))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("Reports in Spanish", () => {
  it("titles and lists the registry in Spanish", async () => {
    mockFetch({ "GET /api/v2/reports": { body: LIST } });
    setLanguage("es");
    renderRoute(<Reports />, { path: "/reports" });
    expect(await screen.findByText("Ventas por compañía")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reportes MSB" })).toBeInTheDocument();
  });

  it("says a failed list in Spanish", async () => {
    mockFetch({ "GET /api/v2/reports": { status: 500, body: { detail: "Servidor caído." } } });
    setLanguage("es");
    renderRoute(<Reports />, { path: "/reports" });
    expect(await screen.findByText("No se pudo cargar la lista de reportes. Servidor caído."))
      .toBeInTheDocument();
  });
});

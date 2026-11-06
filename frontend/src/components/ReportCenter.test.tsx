import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import ReportCenter, { type ReportCategoryRow } from "./ReportCenter";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The report center lists the server's report registry by category,
// with a live search. The registry is server text; the reports we
// ship words for are shown in the person's language, and a report
// the SPA does not know yet (added server-side first) shows as sent.

const ICON = "<svg></svg>";
const CATEGORIES: ReportCategoryRow[] = [
  {
    key: "sales", label: "Sales", icon: ICON,
    reports: [
      {
        key: "sales_by_company", label: "Sales by company",
        description: "Volume, fees, and federal tax split between Intermex, Maxi, and Barri.",
        url: "/reports/sales-by-company", status: "ready",
      },
      {
        key: "brand_new_report", label: "Brand new report",
        description: "Added on the server before the SPA knew it.",
        url: null, status: "coming_soon",
      },
    ],
  },
  {
    key: "audit", label: "Audit", icon: ICON,
    reports: [
      {
        key: "cancelled_transfers", label: "Cancelled transfers",
        description: "Transfers cancelled or rejected within the period.",
        url: "/reports/cancelled-transfers", status: "ready",
      },
    ],
  },
];

function renderCenter() {
  return render(
    <MemoryRouter>
      <ReportCenter title="MSB reports" categories={CATEGORIES} />
    </MemoryRouter>,
  );
}

describe("ReportCenter", () => {
  it("lists each category with its reports, a View link or Coming soon", () => {
    renderCenter();
    expect(screen.getByText("Sales")).toBeInTheDocument();
    expect(screen.getByText("Sales by company")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View" }).map((a) => a.getAttribute("href")))
      .toEqual(["/reports/sales-by-company", "/reports/cancelled-transfers"]);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });

  it("searches names and descriptions, and says when nothing matches", async () => {
    renderCenter();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search reports" }), "rejected");
    expect(screen.getByText("Cancelled transfers")).toBeInTheDocument();
    expect(screen.queryByText("Sales by company")).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.getByText("No reports match that search.")).toBeInTheDocument();
  });
});

describe("ReportCenter in Spanish", () => {
  it("names the reports we ship in Spanish and an unknown one as sent", () => {
    setLanguage("es");
    renderCenter();
    expect(screen.getByText("Ventas")).toBeInTheDocument();
    expect(screen.getByText("Ventas por compañía")).toBeInTheDocument();
    expect(screen.getByText(/repartidos entre Intermex, Maxi y Barri/)).toBeInTheDocument();
    expect(screen.getByText("Auditoría")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Ver" })).toHaveLength(2);
    expect(screen.getByText("Próximamente")).toBeInTheDocument();
    // Not in our word list: the server's own text.
    expect(screen.getByText("Brand new report")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["reports.", "reportCat.", "reportName.", "reportDesc."]))
      .toEqual([]);
  });

  it("searches the Spanish words on screen", async () => {
    setLanguage("es");
    renderCenter();
    const box = screen.getByRole("searchbox", { name: "Buscar reportes" });
    await userEvent.type(box, "rechazados");
    const card = screen.getByText("Envíos cancelados").closest("details")!;
    expect(within(card).getByText("Auditoría")).toBeInTheDocument();
    expect(screen.queryByText("Ventas por compañía")).not.toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "zzz");
    expect(screen.getByText("Ningún reporte coincide con esa búsqueda.")).toBeInTheDocument();
  });
});

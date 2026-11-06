import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminBIDrilldown from "./SuperadminBIDrilldown";
import { setLanguage } from "../../i18n";
import { mockFetch, type MockHandler } from "../../test/fetchMock";
import { renderRoute, signInAs } from "../../test/renderRoute";
import { englishLeftovers } from "../../test/i18n";

// One page draws every platform BI report from the server's
// {rows, totals} answer. Pinned: the title is the report center's
// name for the slug (a slug it doesn't know is humanized), totals
// become tiles, rows a table, a failed load offers a retry, and the
// page's own words read in Spanish. Field names stay as sent.

vi.mock("react-chartjs-2", () => ({
  Line: () => <div data-testid="chart" />,
  Bar: () => <div data-testid="chart" />,
}));

const MRR = {
  rows: [{ plan: "basic", stores: 2, mrr: 60 }, { plan: "pro", stores: 1, mrr: 49 }],
  totals: { mrr: 109, stores: 3 },
};

function renderAt(slug: string, routes: Record<string, MockHandler>) {
  mockFetch(routes);
  renderRoute(<SuperadminBIDrilldown />, {
    path: "/superadmin/reports/:slug", at: `/superadmin/reports/${slug}`,
  });
}

beforeEach(() => {
  signInAs({ role: "superadmin", store_id: null, permissions: [] });
  localStorage.removeItem("dinerobook.bi.view-mode.mrr-arr");
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("SuperadminBIDrilldown", () => {
  it("titles the report by its report center name and draws totals and rows", async () => {
    renderAt("mrr-arr", { "GET /api/v2/superadmin/reports/mrr-arr": { body: MRR } });
    expect(await screen.findByText("basic")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MRR / ARR" })).toBeInTheDocument();
    expect(screen.getByText("2 rows")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "MRR" })).toBeInTheDocument();
    expect(screen.getByTestId("chart")).toBeInTheDocument();
  });

  it("humanizes a slug it has no name for", async () => {
    renderAt("new-thing", { "GET /api/v2/superadmin/reports/new-thing": { body: { rows: [], totals: {} } } });
    expect(await screen.findByText("No data in this period.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "New Thing" })).toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    let fail = true;
    renderAt("mrr-arr", {
      "GET /api/v2/superadmin/reports/mrr-arr": () => (fail
        ? { status: 500, body: { detail: "Database unavailable." } }
        : { body: MRR }),
    });
    expect(await screen.findByText("Couldn't load report — Database unavailable.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("basic")).toBeInTheDocument();
  });

  it("reads in Spanish, field names kept as sent", async () => {
    setLanguage("es");
    renderAt("mrr-arr", { "GET /api/v2/superadmin/reports/mrr-arr": { body: MRR } });
    expect(await screen.findByText("2 filas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Exportar CSV" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Vista" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gráfica" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Stores" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saBI.", "rep."])).toEqual([]);
  });
});

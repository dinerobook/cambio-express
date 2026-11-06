import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminSetupProgress from "./SuperadminSetupProgress";
import { canAccessWith } from "../lib/access";
import { filterNavForRole } from "../components/navConfig";
import { callsTo, mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";
import type { SuperadminSetupProgressRow } from "../api/superadmin";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Platform → Setup progress. Pinned: each step's cell (done, not done,
// does not apply), the open filter as the default, filters and paging
// in the URL reaching the API, empty / error states, and that only a
// superadmin loads it, reaches it or sees it in the sidebar.

const URL = "GET /api/v2/superadmin/setup-progress";

const row = (over: Partial<SuperadminSetupProgressRow> = {}): SuperadminSetupProgressRow => ({
  store_id: 1, name: "Cambio Uno", slug: "cambio-uno", plan: "trial",
  is_active: true, signed_up_on: "2026-10-30", days_since_signup: 5,
  companies_added: false, company_count: 0,
  charges_set: false, money_order_companies: 3, money_order_charges_set: 0,
  bank_connected: false, first_locked_day: null,
  steps_done: 0, steps_total: 4,
  ...over,
});

function page(rows: SuperadminSetupProgressRow[], extra: Record<string, unknown> = {}) {
  return { rows, total: rows.length, page: 1, total_pages: 1, ...extra };
}

function renderPage(at = "/superadmin/setup-progress") {
  return renderRoute(<SuperadminSetupProgress />, { path: "/superadmin/setup-progress", at });
}

const rowOf = async (name: string) => (await screen.findByText(name)).closest("tr")!;

describe("SuperadminSetupProgress", () => {
  beforeEach(() => {
    signInAs({ role: "superadmin", store_id: null });
    localStorage.removeItem("db.page_size.setup-progress");
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows a stuck store's missing steps", async () => {
    mockFetch({ [URL]: { body: page([row()]) } });
    renderPage();
    const tr = await rowOf("Cambio Uno");
    for (const text of ["Not added", "0 of 3 set", "Not connected", "Not yet", "0 of 4", "5 days ago"]) {
      expect(tr).toHaveTextContent(text);
    }
    expect(within(tr).getByRole("link", { name: "View" }))
      .toHaveAttribute("href", "/superadmin/stores/1/drill");
    expect(screen.getByText("1 store")).toBeInTheDocument();
  });

  it("shows a finished store's steps as done", async () => {
    mockFetch({
      [URL]: {
        body: page([row({
          name: "Ready", companies_added: true, company_count: 2,
          charges_set: true, money_order_companies: 2, money_order_charges_set: 2,
          bank_connected: true, first_locked_day: "2026-10-01",
          steps_done: 4, steps_total: 4, days_since_signup: 0,
        })]),
      },
    });
    renderPage();
    const tr = await rowOf("Ready");
    for (const text of ["2 companies", "2 of 2 set", "Connected", "Oct 1, 2026", "4 of 4", "Today"]) {
      expect(tr).toHaveTextContent(text);
    }
    expect(tr).not.toHaveTextContent("Not connected");
  });

  it("shows a dash for steps that do not apply", async () => {
    mockFetch({
      [URL]: {
        body: page([row({
          name: "Corner Shop", companies_added: null, charges_set: null,
          money_order_companies: 0, steps_total: 2,
        })]),
      },
    });
    renderPage();
    const tr = await rowOf("Corner Shop");
    expect(within(tr).getAllByTitle("Does not apply to this store")).toHaveLength(2);
    expect(tr).toHaveTextContent("0 of 2");
    expect(tr).not.toHaveTextContent("Not added");
  });

  it("asks for stores not finished by default", async () => {
    const calls = mockFetch({ [URL]: { body: page([row()]) } });
    renderPage();
    await screen.findByText("Cambio Uno");
    const qs = callsTo(calls, URL)[0].url.searchParams;
    expect(qs.get("status")).toBe("open");
    expect(qs.get("per_page")).toBe("50");
    expect(screen.getByLabelText("Setup")).toHaveValue("open");
  });

  it("sends the URL's filters and the picked status to the API", async () => {
    const calls = mockFetch({ [URL]: { body: page([row()]) } });
    renderPage("/superadmin/setup-progress?q=cambio&status=all");
    await screen.findByText("Cambio Uno");
    let qs = callsTo(calls, URL)[0].url.searchParams;
    expect(qs.get("q")).toBe("cambio");
    expect(qs.get("status")).toBe("all");
    await userEvent.selectOptions(screen.getByLabelText("Setup"), "done");
    await waitFor(() => {
      qs = callsTo(calls, URL).at(-1)!.url.searchParams;
      expect(qs.get("status")).toBe("done");
    });
  });

  it("falls back to not finished for an unknown status in the URL", async () => {
    const calls = mockFetch({ [URL]: { body: page([row()]) } });
    renderPage("/superadmin/setup-progress?status=bogus");
    await screen.findByText("Cambio Uno");
    expect(callsTo(calls, URL)[0].url.searchParams.get("status")).toBe("open");
  });

  it("searches as you type and pages on", async () => {
    const calls = mockFetch({ [URL]: { body: page([row()], { total: 120, total_pages: 3 }) } });
    renderPage();
    await screen.findByText("Cambio Uno");
    await userEvent.type(screen.getByLabelText("Search stores"), "uno");
    await waitFor(() => expect(callsTo(calls, URL).at(-1)!.url.searchParams.get("q")).toBe("uno"));
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(callsTo(calls, URL).at(-1)!.url.searchParams.get("page")).toBe("2"));
  });

  it("says every store is set up when nothing is open", async () => {
    mockFetch({ [URL]: { body: page([]) } });
    renderPage();
    expect(await screen.findByText("Every store has finished setup.")).toBeInTheDocument();
  });

  it("says nothing matches on other filters", async () => {
    mockFetch({ [URL]: { body: page([]) } });
    renderPage("/superadmin/setup-progress?status=all&q=zz");
    expect(await screen.findByText("No stores match the filters.")).toBeInTheDocument();
  });

  it("shows the server's error with a retry", async () => {
    mockFetch({ [URL]: { status: 500, body: { detail: "Setup list down" } } });
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Setup list down");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("does not load for anyone but a superadmin", () => {
    const calls = mockFetch({ [URL]: { body: page([row()]) } });
    signInAs();
    renderPage();
    expect(callsTo(calls, URL)).toHaveLength(0);
  });

  it("is reachable and in the sidebar for the superadmin only", () => {
    const to = "/superadmin/setup-progress";
    const all = ["superadmin.manage", "settings.manage", "dailybook.view"];
    expect(canAccessWith({ role: "superadmin", permissions: [] }, to)).toBe(true);
    for (const role of ["admin", "employee", "owner", "support"]) {
      expect(canAccessWith({ role, permissions: all }, to)).toBe(false);
    }
    const links = (role: string) => filterNavForRole(role, all)
      .flatMap((g) => g.items.map((i) => i.to));
    expect(links("superadmin")).toContain(to);
    expect(links("support")).not.toContain(to);
    expect(links("admin")).not.toContain(to);
  });

  it("reads in Spanish, cells and filters included", async () => {
    mockFetch({ [URL]: { body: page([row(), row({ store_id: 2, name: "Cambio Dos", days_since_signup: 1,
      companies_added: true, company_count: 1, is_active: false })]) } });
    setLanguage("es");
    renderPage();
    const uno = await rowOf("Cambio Uno");
    for (const text of ["Sin agregar", "0 de 3 configurados", "Sin conectar", "Todavía no", "0 de 4", "hace 5 días"]) {
      expect(uno).toHaveTextContent(text);
    }
    const dos = await rowOf("Cambio Dos");
    expect(dos).toHaveTextContent("1 compañía");
    expect(dos).toHaveTextContent("hace 1 día");
    expect(dos).toHaveTextContent("· inactiva");
    expect(screen.getByText("2 tiendas")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sin terminar" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["saSetup."])).toEqual([]);
  });
});

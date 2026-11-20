import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import DeveloperFiles from "./DeveloperFiles";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// The store's Developer tab: only while a superadmin is signed in as
// the store. It starts on the files that did not import, the filters
// reach the API, a row opens its file, and anyone not impersonating
// is sent home without a single files request.

const impersonating = {
  store_name: "Luck Stop", features: [], permissions: [],
  impersonation: { by_user_id: 1, by_name: "Platform", read_only: true },
};

const broken = {
  id: 7, filename: "PJR3402603031228513195298.xml", kind: "unknown",
  event_kind: "", business_date: null, received_at: "2026-03-03T18:28:51",
  imported: false, reason: "Not well-formed XML.",
};
const sale = {
  id: 8, filename: "PJR3402603031230003195302.xml", kind: "journal",
  event_kind: "sale", business_date: "2026-03-02",
  received_at: "2026-03-03T18:30:00", imported: true, reason: "",
};

const list = (over: Record<string, unknown> = {}) => ({
  rows: [broken], total: 1, page: 1, total_pages: 1,
  summary: { files: 1240, not_imported: 1, last_received_at: "2026-03-03T18:30:00" },
  store_id: 1, store_name: "Luck Stop", ...over,
});

describe("Developer tab — the store's files", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem("db.page_size.developer-files");
  });

  it("starts on the files that did not import, with why", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files": { body: list() },
    });
    renderRoute(<DeveloperFiles />, { path: "/developer/files" });
    const row = (await screen.findByText(broken.filename)).closest("tr")!;
    expect(row).toHaveTextContent("Not imported");
    expect(row).toHaveTextContent("Not well-formed XML.");
    expect(row).toHaveTextContent("Unreadable");
    expect(screen.getByText("1,240")).toBeInTheDocument();
    expect(screen.getByText(/Luck Stop · Store ID 1/)).toBeInTheDocument();
    const sent = calls.filter((c) => c.url.pathname === "/api/v2/developer/files").at(-1)!;
    expect(sent.url.searchParams.get("status")).toBe("not_imported");
    expect(sent.url.searchParams.get("sort")).toBe("received");
    expect(sent.url.searchParams.get("direction")).toBe("desc");
  });

  it("sends the filters and opens a file from its row", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files": { body: list({ rows: [sale] }) },
    });
    const user = userEvent.setup();
    renderRoute(<DeveloperFiles />, { path: "/developer/files" });
    await screen.findByText(sale.filename);
    const last = () => calls.filter((c) => c.url.pathname === "/api/v2/developer/files").at(-1)!;

    await user.selectOptions(screen.getByLabelText("Status"), "all");
    await waitFor(() => expect(last().url.searchParams.get("status")).toBeNull());
    await user.selectOptions(screen.getByLabelText("Type"), "movement");
    await waitFor(() => expect(last().url.searchParams.get("kind")).toBe("movement"));
    await user.type(screen.getByLabelText("Search files"), "well-formed");
    await waitFor(() => expect(last().url.searchParams.get("q")).toBe("well-formed"));

    const row = screen.getByText(sale.filename).closest("tr")!;
    expect(row).toHaveTextContent("Sale");
    expect(row).toHaveTextContent("Imported");
    screen.getByRole("button", { name: `Open ${sale.filename}` }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(/Navigated to \/developer\/files\/8/)).toBeInTheDocument();
  });

  it("sends anyone not impersonating home, asking for no files", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/session-status": { body: { ...impersonating, impersonation: null } },
      "GET /api/v2/developer/files": { body: list() },
    });
    renderRoute(<DeveloperFiles />, { path: "/developer/files" });
    expect(await screen.findByText(/Navigated to \/dashboard/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname === "/api/v2/developer/files")).toBe(false);
  });

  it("shows a retry when the files fail to load", async () => {
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files": { status: 403, body: { detail: "no" } },
    });
    renderRoute(<DeveloperFiles />, { path: "/developer/files" });
    expect(await screen.findByText("Could not load the files.")).toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files": { body: list({ rows: [broken, sale] }) },
    });
    renderRoute(<DeveloperFiles />, { path: "/developer/files" });
    await screen.findByText(broken.filename);
    expect(screen.getByRole("heading", { name: /Desarrollador/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Estado")).toHaveDisplayValue("No importado");
    // A sortable heading carries its arrow (↕ ▲ ▼); compare the words.
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent?.replace(/[↕▲▼]/g, "")))
      .toEqual(expect.arrayContaining(["Archivo", "Tipo", "Día de negocio", "Recibido"]));
    expect(screen.getByText(sale.filename).closest("tr")!).toHaveTextContent("Venta");
    expect(englishLeftovers(document.body, ["dev."])).toEqual([]);
  });
});

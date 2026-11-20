import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DeveloperFile from "./DeveloperFile";
import { mockFetch } from "../test/fetchMock";
import { renderRoute } from "../test/renderRoute";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// One file the register sent: why it did (not) import, its facts,
// and the XML as text with a line number per line — plus the ways
// out: copy, the raw text in a new tab, the exact bytes as a file.

const impersonating = {
  store_name: "Luck Stop", features: [], permissions: [],
  impersonation: { by_user_id: 1, by_name: "Platform", read_only: true },
};

const XML = '<?xml version="1.0" encoding="ISO-8859-1"?>\n<NAXML-POSJournal>\n<SaleEvent/>\n</NAXML-POSJournal>';

const detail = (over: Record<string, unknown> = {}, file: Record<string, unknown> = {}) => ({
  file: {
    id: 7, filename: "PJR3402603031228513195298.xml", kind: "unknown",
    event_kind: "", business_date: null, received_at: "2026-03-03T18:28:51",
    imported: false, reason: "Not a NAXML POSJournal document (root <ItemMaintenance>).",
    ...file,
  },
  store_id: 1, store_name: "Luck Stop", size_bytes: 5123, xml: XML,
  encoding: "iso8859-1", truncated: false, line_count: 4,
  ...over,
});

function at(path = "/developer/files/7") {
  return renderRoute(<DeveloperFile />, { path: "/developer/files/:id", at: path });
}

describe("Developer tab — one file", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("says why it did not import and shows the XML line by line", async () => {
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files/7": { body: detail() },
    });
    at();
    expect(await screen.findByText("Why it did not import")).toBeInTheDocument();
    expect(screen.getByText(/root <ItemMaintenance>/)).toBeInTheDocument();
    expect(screen.getByText("5,123 bytes (5.0 KB)")).toBeInTheDocument();
    expect(screen.getByText("Encoding: iso8859-1")).toBeInTheDocument();
    const xml = screen.getByTestId("developer-xml");
    expect(xml.children).toHaveLength(4);
    expect(xml.textContent).toBe(`${XML}\n`);
    expect(screen.getByRole("heading", { name: "PJR3402603031228513195298.xml" })).toBeInTheDocument();
  });

  it("opens the raw text in a new tab and downloads the exact file", async () => {
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files/7": { body: detail() },
    });
    at();
    const open = await screen.findByRole("link", { name: "Open as text" });
    expect(open).toHaveAttribute("href", "/api/v2/developer/files/7/raw");
    expect(open).toHaveAttribute("target", "_blank");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    const download = screen.getByRole("link", { name: "Download" });
    expect(download).toHaveAttribute("href", "/api/v2/developer/files/7/raw?download=1");
    expect(download).toHaveAttribute("download", "PJR3402603031228513195298.xml");
    expect(screen.getByRole("button", { name: "Copy XML" })).toBeInTheDocument();
  });

  it("an imported file says so; a huge one says only its start is shown", async () => {
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files/7": {
        body: detail({ truncated: true }, {
          kind: "journal", event_kind: "sale", imported: true, reason: "",
          business_date: "2026-03-02",
        }),
      },
    });
    at();
    expect(await screen.findByText(/This file was read/)).toBeInTheDocument();
    expect(screen.queryByText("Why it did not import")).not.toBeInTheDocument();
    expect(screen.getByText(/Showing the first 2 MB/)).toBeInTheDocument();
    expect(screen.getByText("Sale")).toBeInTheDocument();
  });

  it("sends anyone not impersonating home", async () => {
    const calls = mockFetch({
      "GET /api/v2/auth/session-status": { body: { ...impersonating, impersonation: null } },
      "GET /api/v2/developer/files/7": { body: detail() },
    });
    at();
    expect(await screen.findByText(/Navigated to \/dashboard/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname.startsWith("/api/v2/developer/"))).toBe(false);
  });

  it("shows a retry when the file is not there", async () => {
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files/7": { status: 404, body: { detail: "File not found" } },
    });
    at();
    expect(await screen.findByText("Could not load the file.")).toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    mockFetch({
      "GET /api/v2/auth/session-status": { body: impersonating },
      "GET /api/v2/developer/files/7": { body: detail() },
    });
    at();
    expect(await screen.findByText("Por qué no se importó")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abrir como texto" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Descargar" })).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["dev."])).toEqual([]);
  });
});

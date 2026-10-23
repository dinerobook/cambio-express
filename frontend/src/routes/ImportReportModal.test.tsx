import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportReportModal } from "./ImportReportModal";
import type { IntermexCommit, IntermexReport } from "../api/reportImport";

// The Intermex daily-close import (switched off on the daily book until
// it gets its own integration, but kept working): upload → review the
// parsed giros → commit, which is only offered when every giro
// reconciles. The server re-parses on commit; the client sends the file.

const parseIntermexReport = vi.fn();
const commitIntermexReport = vi.fn();

vi.mock("../api/reportImport", () => ({
  parseIntermexReport: (f: File) => parseIntermexReport(f),
  commitIntermexReport: (f: File, s: number, d: string) => commitIntermexReport(f, s, d),
}));

const GIRO = {
  section: "giros", confirm_number: "MX-1001", cashier: "Ana",
  send_amount: 200, fee: 5, federal_tax: 2, total_collected: 207,
  cancelled: false, replacement: false, reconciles: true,
};

function report(over: Partial<IntermexReport> = {}): IntermexReport {
  return {
    agency: "Tienda Uno", report_date: "2026-10-20", all_reconcile: true,
    giros: [GIRO], money_orders: [], bill_payments: [],
    giros_totals: null, money_order_totals: null, bill_payment_totals: null,
    ...over,
  };
}

const COMMIT: IntermexCommit = {
  company: "Intermex", giros_committed: 1, amount: 200, fees: 5,
  federal_tax: 2, committed_total: 207, grand_total: 207,
  logged_amount: 200, logged_total: 207, matches_logged: true,
  previous_saved_total: 0,
} as IntermexCommit;

const pdf = new File(["%PDF"], "cierre.pdf", { type: "application/pdf" });

function renderModal(onCommitted = vi.fn(), onClose = vi.fn()) {
  render(
    <ImportReportModal open storeId={7} reportDate="2026-10-20"
      onClose={onClose} onCommitted={onCommitted} />,
  );
  return { onCommitted, onClose };
}

function upload() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [pdf] } });
}

beforeEach(() => {
  parseIntermexReport.mockReset();
  commitIntermexReport.mockReset();
});

describe("ImportReportModal", () => {
  it("shows the parsed giros for review", async () => {
    parseIntermexReport.mockResolvedValue(report());
    renderModal();
    upload();
    expect(await screen.findByText("MX-1001")).toBeInTheDocument();
    expect(parseIntermexReport).toHaveBeenCalledWith(pdf);
    expect(screen.getByText("All transfers reconcile")).toBeInTheDocument();
    expect(screen.getByText("$207.00")).toBeInTheDocument();
  });

  it("commits the file to the day being edited", async () => {
    parseIntermexReport.mockResolvedValue(report());
    commitIntermexReport.mockResolvedValue(COMMIT);
    const { onCommitted } = renderModal();
    upload();
    await userEvent.click(await screen.findByRole("button", { name: "Commit to money transfers" }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1));
    expect(commitIntermexReport).toHaveBeenCalledWith(pdf, 7, "2026-10-20");
    expect(screen.getByText(/Matches the transfers already logged/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("refuses to commit when the giros don't reconcile", async () => {
    parseIntermexReport.mockResolvedValue(report({
      all_reconcile: false, giros: [{ ...GIRO, reconciles: false }],
    }));
    renderModal();
    upload();
    expect(await screen.findByRole("button", { name: "Commit to money transfers" })).toBeDisabled();
    expect(screen.getByText("Check")).toBeInTheDocument();
  });

  it("warns when the report is for another day", async () => {
    parseIntermexReport.mockResolvedValue(report({ report_date: "2026-10-19" }));
    renderModal();
    upload();
    expect(await screen.findByText(/but you’re editing/)).toBeInTheDocument();
  });

  it("shows the server's reason when the file can't be read", async () => {
    parseIntermexReport.mockRejectedValue(new Error("Not an Intermex report"));
    renderModal();
    upload();
    expect(await screen.findByText("Not an Intermex report")).toBeInTheDocument();
    expect(screen.queryByText("MX-1001")).not.toBeInTheDocument();
  });

  it("keeps the review open and says why when the commit fails", async () => {
    parseIntermexReport.mockResolvedValue(report());
    commitIntermexReport.mockRejectedValue(new Error("Day is locked"));
    const { onCommitted } = renderModal();
    upload();
    await userEvent.click(await screen.findByRole("button", { name: "Commit to money transfers" }));
    expect(await screen.findByText("Day is locked")).toBeInTheDocument();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(screen.getByText("MX-1001")).toBeInTheDocument();
  });
});

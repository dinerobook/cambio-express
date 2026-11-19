import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModisoftImportModal } from "./ModisoftImportModal";
import type { ModisoftImportReport } from "../api/catalog";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Price book → Import from Modisoft. Pinned here:
//   - choosing a file runs the CHECK (apply=false) and shows its report;
//   - Import sends the same file with apply=true, then closes;
//   - turning "Update items already in my price book" off re-checks;
//   - a file the server refuses shows its reason, and nothing imports;
//   - the whole popup reads in Spanish.

const importModisoftPriceBook = vi.fn();

vi.mock("../api/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/catalog")>();
  return {
    ...real,
    importModisoftPriceBook: (...a: unknown[]) => importModisoftPriceBook(...a),
  };
});

function report(over: Partial<ModisoftImportReport> = {}): ModisoftImportReport {
  return {
    applied: false, rows_read: 20887, items_new: 1200, items_updated: 34,
    items_unchanged: 19000, items_skipped: 0, matched_other_spelling: 3,
    products_new: 900, products_known: 7864, store_codes: 845,
    departments_new: ["Beer", "Soda"], columns_used: ["Scan Code"],
    columns_ignored: ["Margin"],
    issues: [
      { code: "duplicate_code", count: 2, examples: [{ line: 7, scan_code: "7" }, { line: 9, scan_code: "8" }] },
      { code: "negative_number", count: 1, examples: [{ line: 12, scan_code: "99" }] },
    ],
    ...over,
  };
}

const xlsx = new File(["PK"], "Vendors Price Book.xlsx", {
  type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

function renderModal() {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <ModisoftImportModal open onClose={onClose} onDone={onDone} />
    </ToastProvider>,
  );
  return { onDone, onClose };
}

function choose() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [xlsx] } });
}

describe("ModisoftImportModal", () => {
  beforeEach(() => {
    setCurrentIdentity(TEST_ADMIN);
    importModisoftPriceBook.mockReset();
  });

  it("checks the file first and shows what would happen", async () => {
    importModisoftPriceBook.mockResolvedValue(report());
    renderModal();
    choose();
    expect(await screen.findByText("20,887 item rows in the file.")).toBeInTheDocument();
    expect(importModisoftPriceBook).toHaveBeenCalledWith(xlsx, {
      apply: false, updateExisting: true,
    });
    expect(screen.getByText("1,200")).toBeInTheDocument();
    expect(screen.getByText("19,000 already up to date")).toBeInTheDocument();
    expect(screen.getByText("Departments to add: Beer, Soda.")).toBeInTheDocument();
    expect(screen.getByText(/7,864 barcodes are already in the shared/)).toBeInTheDocument();
    expect(screen.getByText(/845 codes are your store's own/)).toBeInTheDocument();
    expect(screen.getByText("Not imported: Margin.")).toBeInTheDocument();
    expect(screen.getByText(/2 rows repeat a scan code/)).toHaveTextContent("(lines 7, 9)");
    expect(screen.getByText(/1 negative amount/)).toHaveTextContent("(line 12)");
    expect(screen.getByText("Vendors Price Book.xlsx")).toBeInTheDocument();
  });

  it("imports the same file and closes", async () => {
    importModisoftPriceBook
      .mockResolvedValueOnce(report())
      .mockResolvedValueOnce(report({ applied: true }));
    const { onDone } = renderModal();
    choose();
    const button = await screen.findByRole("button", { name: "Import 1,234 items" });
    await userEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(importModisoftPriceBook).toHaveBeenLastCalledWith(xlsx, {
      apply: true, updateExisting: true,
    });
    expect(await screen.findByText("Price book imported: 1,200 new, 34 updated.")).toBeInTheDocument();
  });

  it("re-checks when existing items are to be left alone", async () => {
    importModisoftPriceBook
      .mockResolvedValueOnce(report())
      .mockResolvedValueOnce(report({ items_updated: 0, items_skipped: 19034 }));
    renderModal();
    choose();
    await screen.findByText("20,887 item rows in the file.");
    await userEvent.click(screen.getByRole("checkbox", { name: /Update items already/ }));
    expect(await screen.findByText("19,034 already in your price book, left alone")).toBeInTheDocument();
    expect(importModisoftPriceBook).toHaveBeenLastCalledWith(xlsx, {
      apply: false, updateExisting: false,
    });
    expect(screen.getByRole("button", { name: "Import 1,200 items" })).toBeEnabled();
  });

  it("shows the server's reason for a file it cannot read", async () => {
    importModisoftPriceBook.mockRejectedValue(
      new ApiError(422, "The file has no Unit Retail column.", null),
    );
    renderModal();
    choose();
    expect(await screen.findByText("The file has no Unit Retail column.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  });

  it("nothing to write means nothing to press", async () => {
    importModisoftPriceBook.mockResolvedValue(
      report({ items_new: 0, items_updated: 0, issues: [] }),
    );
    renderModal();
    choose();
    expect(await screen.findByRole("button", { name: "Nothing to import" })).toBeDisabled();
  });

  it("reads in Spanish", async () => {
    importModisoftPriceBook.mockResolvedValue(report());
    setLanguage("es");
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Importar una lista de precios de Modisoft" });
    expect(englishLeftovers(dialog, ["pb."])).toEqual([]);
    choose();
    await within(dialog).findByText("20,887 filas de artículos en el archivo.");
    expect(within(dialog).getByRole("button", { name: "Importar 1,234 artículos" })).toBeInTheDocument();
    expect(englishLeftovers(dialog, ["pb."])).toEqual([]);
  });
});

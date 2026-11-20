import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DepartmentImportModal } from "./DepartmentImportModal";
import { ToastProvider } from "./ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";

// Account → Departments → Import from Modisoft. Pinned: nothing is
// sent until Import; a Lottery / Services row is marked for its type
// to be checked and offers only its own group's types; the person's
// pick is what gets imported; a row Modisoft does not use starts
// unticked and a refused row cannot be ticked; Spanish.

const checkModisoftDepartments = vi.fn();
const importDepartments = vi.fn();

vi.mock("../api/dayclose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/dayclose")>()),
  checkModisoftDepartments: (...a: unknown[]) => checkModisoftDepartments(...a),
  importDepartments: (...a: unknown[]) => importDepartments(...a),
}));

const ROW = {
  pos_code: null as string | null, modisoft_type: "Merchandise",
  type_group: "merchandise", department_type: "merchandise", type_sure: true,
  is_taxable: true as boolean | null, tax_rate: 0.0825 as number | null,
  min_age: 0 as number | null, nacs_code: "400" as string | null, items: 10,
  status: "new", existing_id: null as number | null, existing_name: "",
  existing_type: null as string | null, changes: [] as string[],
  problem: null as string | null, problem_name: "", unused: false, include: true,
};

const CHECK = {
  columns_used: ["POS Dept", "Department Name"],
  columns_ignored: [],
  issues: [{ code: "bad_number", count: 1, lines: [9] }],
  rows: [
    { ...ROW, line: 6, name: "BEER", pos_code: "4", min_age: 21, nacs_code: "481" },
    {
      ...ROW, line: 7, name: "LOTTO PAID OUT", pos_code: "16",
      modisoft_type: "Lottery", type_group: "lottery",
      department_type: "lotto_cash", type_sure: false,
      is_taxable: false, tax_rate: null,
    },
    {
      ...ROW, line: 8, name: "DEBIT FEES", pos_code: "44",
      modisoft_type: "Services", type_group: "services",
      department_type: "service", type_sure: false,
      is_taxable: false, tax_rate: null,
    },
    {
      ...ROW, line: 9, name: "BEVERAGES", items: 0, unused: true, include: false,
      is_taxable: null, tax_rate: null, nacs_code: null,
    },
    {
      ...ROW, line: 10, name: "CHIPS", pos_code: "29", status: "skip",
      problem: "pos_taken", problem_name: "Candy", include: false,
    },
    {
      ...ROW, line: 11, name: "WINE", pos_code: "5", status: "update",
      existing_id: 3, existing_name: "Wine & Beer", existing_type: "merchandise",
      changes: ["name", "tax"],
    },
  ],
};

const onDone = vi.fn();

function renderModal() {
  return render(
    <ToastProvider>
      <DepartmentImportModal open onClose={vi.fn()} onDone={onDone} />
    </ToastProvider>,
  );
}

async function chooseFile(label = "Modisoft departments file") {
  const file = new File(["x"], "Departments.xls", { type: "application/vnd.ms-excel" });
  await userEvent.upload(screen.getByLabelText(label), file, { applyAccept: false });
  return file;
}

function rowOf(name: string) {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

beforeEach(() => {
  setCurrentIdentity(TEST_ADMIN);
  setLanguage("en");
  checkModisoftDepartments.mockReset().mockResolvedValue(CHECK);
  importDepartments.mockReset().mockResolvedValue({ created: 3, updated: 1, unchanged: 0 });
  onDone.mockReset();
});

describe("<DepartmentImportModal>", () => {
  it("checks the file and shows the plan without importing", async () => {
    renderModal();
    const file = await chooseFile();
    await screen.findByText("6 departments in the file.");
    expect(checkModisoftDepartments).toHaveBeenCalledWith(file);
    expect(importDepartments).not.toHaveBeenCalled();

    expect(screen.getByText(/Check the type of each marked department/)).toBeInTheDocument();
    expect(screen.getAllByText("Check this type")).toHaveLength(2);
    expect(screen.getByText(/1 department has no register number/)).toBeInTheDocument();
    expect(screen.getByText(/1 tax rate or age could not be read/)).toBeInTheDocument();

    const lotto = within(rowOf("LOTTO PAID OUT")).getByRole("combobox", {
      name: "Type for LOTTO PAID OUT",
    });
    expect(lotto).toHaveDisplayValue("Lotto paid out");
    expect(within(lotto).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Lottery sales", "Lottery paid out", "Lotto sales", "Lotto paid out",
    ]);
    // A Merchandise row can still be moved to any type.
    const beer = within(rowOf("BEER")).getByRole("combobox");
    expect(within(beer).getAllByRole("option")).toHaveLength(13);

    const chips = rowOf("CHIPS");
    expect(within(chips).getByText("POS no 29 belongs to Candy.")).toBeInTheDocument();
    expect(within(chips).getByRole("checkbox")).toBeDisabled();
    expect(within(rowOf("BEVERAGES")).getByRole("checkbox")).not.toBeChecked();
    expect(within(rowOf("WINE")).getByText("Was Wine & Beer · name, tax")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 4 departments" })).toBeEnabled();
  });

  it("imports the kept rows with the type the person picked", async () => {
    renderModal();
    await chooseFile();
    await screen.findByText("6 departments in the file.");
    await userEvent.selectOptions(
      within(rowOf("DEBIT FEES")).getByRole("combobox"), "check_cash_fee",
    );
    await userEvent.click(within(rowOf("BEVERAGES")).getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Import 5 departments" }));

    await waitFor(() => expect(importDepartments).toHaveBeenCalledTimes(1));
    const sent = importDepartments.mock.calls[0][0] as { name: string; department_type: string }[];
    expect(sent.map((r) => r.name)).toEqual([
      "BEER", "LOTTO PAID OUT", "DEBIT FEES", "BEVERAGES", "WINE",
    ]);
    expect(sent[0]).toEqual({
      name: "BEER", pos_code: "4", department_type: "merchandise",
      is_taxable: true, tax_rate: 0.0825, min_age: 21, nacs_code: "481",
    });
    expect(sent[2].department_type).toBe("check_cash_fee");
    expect(sent[1].department_type).toBe("lotto_cash");
    expect(await screen.findByText("Departments imported: 3 new, 1 updated.")).toBeInTheDocument();
    expect(onDone).toHaveBeenCalled();
  });

  it("can show only the rows whose type needs a check", async () => {
    renderModal();
    await chooseFile();
    await screen.findByText("6 departments in the file.");
    await userEvent.click(
      screen.getByRole("checkbox", { name: /Show only the 2 departments/ }),
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[2].textContent)).toEqual([
      "LOTTO PAID OUT", "DEBIT FEES",
    ]);
  });

  it("shows why a file was refused", async () => {
    checkModisoftDepartments.mockRejectedValue(
      new ApiError(422, "No header row with Department Name and Depart Type was found.", {
        detail: "No header row with Department Name and Depart Type was found.",
      }),
    );
    renderModal();
    await chooseFile();
    expect(await screen.findByText(/No header row with Department Name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    renderModal();
    await chooseFile("Archivo de departamentos de Modisoft");
    await screen.findByText("6 departamentos en el archivo.");
    expect(screen.getAllByText("Revise este tipo")).toHaveLength(2);
    expect(within(rowOf("LOTTO PAID OUT")).getByRole("combobox")).toHaveDisplayValue(
      "Premios de lotto pagados",
    );
    // Modisoft's own type names and the file's name are data, shown as
    // the file has them.
    const data = new Set(["Lottery", "Services", "Departments"]);
    expect(
      englishLeftovers(document.body, ["deptImport.", "dept."]).filter((w) => !data.has(w)),
    ).toEqual([]);
    setLanguage("en");
  });
});

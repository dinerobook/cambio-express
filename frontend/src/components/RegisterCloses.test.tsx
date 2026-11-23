import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RegisterCloses from "./RegisterCloses";
import { ToastProvider } from "./ui";
import { setLanguage } from "../i18n";
import { setCurrentIdentity } from "../lib/auth";
import { englishLeftovers } from "../test/i18n";
import { TEST_ADMIN } from "../test/setup";

// The section reads through the dayclose hooks; stub them so the
// test is about what the section renders, not about fetching.
const summary = {
  date: "2026-08-31",
  closes: [
    {
      id: 1,
      register_label: "Register 1",
      shift_label: "Morning",
      gross_sales: 1234.5,
      sales_tax: 98.76,
      cash_total: 800,
      card_total: 533.26,
      other_total: 0,
      cash_counted: 795,
      over_short: -5,
      tender_variance: 0,
      notes: "",
      source: "manual",
      department_sales: [],
    },
  ],
  department_totals: [
    { department_id: 7, department_name: "Tobacco", amount: 410.25 },
  ],
  gross_sales: 1234.5,
  sales_tax: 98.76,
  cash_total: 800,
  card_total: 533.26,
  other_total: 0,
  over_short: -5,
  tender_variance: 0,
  uncounted_drawers: 0,
};

const upsertRegisterClose = vi.fn();
const deleteRegisterClose = vi.fn();
let departments: Array<{ id: number; name: string }> = [];

// The day the section is showing; a test may swap in an empty one.
let day: typeof summary = summary;
const EMPTY_DAY: typeof summary = {
  ...summary, closes: [], department_totals: [], gross_sales: 0,
  sales_tax: 0, cash_total: 0, card_total: 0, over_short: 0,
};

vi.mock("../api/dayclose", () => ({
  useDayClose: () => ({ data: day, isLoading: false, isError: false }),
  useDepartments: () => ({ data: { departments } }),
  upsertRegisterClose: (...a: unknown[]) => upsertRegisterClose(...a),
  deleteRegisterClose: (...a: unknown[]) => deleteRegisterClose(...a),
}));

function renderSection(canEdit: boolean) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <RegisterCloses day="2026-08-31" canEdit={canEdit} />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  day = summary;
});

// A day with no closes used to show a big "No register closes for
// this day" block. It says nothing a person can use (owner,
// 2026-11-23), so the section is then only its one-line header: the
// two buttons are the one way to key a close and to reach the
// register import page. With nothing to show and nothing to do, the
// section is not there at all.
describe("RegisterCloses on a day with no closes", () => {
  beforeEach(() => {
    day = EMPTY_DAY;
  });

  it("shows only its header and buttons, no empty-state block", () => {
    renderSection(true);
    expect(screen.getByRole("heading", { name: /Registers/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Import from register" }))
      .toHaveAttribute("href", "/pos-import");
    expect(screen.getByRole("button", { name: "+ Add close" })).toBeInTheDocument();
    expect(screen.queryByText(/No register closes/)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("is not there at all on a locked day", () => {
    const { container } = renderSection(false);
    expect(container).toBeEmptyDOMElement();
  });

  it("is not there at all for someone who can only look", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee", permissions: ["day_close.read"],
    });
    const { container } = renderSection(true);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays for someone who may key a close but not import", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["day_close.read", "day_close.create"],
    });
    renderSection(true);
    expect(screen.getByRole("button", { name: "+ Add close" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Import from register" }))
      .not.toBeInTheDocument();
  });
});

describe("RegisterCloses", () => {
  it("renders the day's closes and the department rollup", () => {
    renderSection(true);
    expect(screen.getByText("Register 1 / Morning")).toBeInTheDocument();
    expect(screen.getByText("Tobacco")).toBeInTheDocument();
    expect(screen.getByText("$410.25")).toBeInTheDocument();
  });

  it("offers editing controls when the day is unlocked", () => {
    renderSection(true);
    expect(screen.getByText("+ Add close")).toBeInTheDocument();
    // RowActions renders "Actions" itself, so pin the assertion to
    // the column header rather than any element carrying the word.
    expect(
      screen.getByRole("columnheader", { name: "Actions" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("hides every write control when the day is locked", () => {
    // A locked sheet shows its register detail read-only — the same
    // rule the money fields above it follow.
    renderSection(false);
    expect(screen.queryByText("+ Add close")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Actions" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    // …but the numbers are still there to read.
    expect(screen.getByText("Register 1 / Morning")).toBeInTheDocument();
  });
});

// The close form's money fields are MoneyInputs: they hand the
// form numbers, so what is typed is what is saved. "Counted drawer
// cash" is the one exception: blank means "not counted" (null), and
// 0 means "counted, empty drawer".
describe("RegisterCloses form", () => {
  beforeEach(() => {
    upsertRegisterClose.mockReset();
    upsertRegisterClose.mockResolvedValue({});
    departments = [];
  });

  it("saves typed amounts as numbers, blank fields as 0, uncounted as null", async () => {
    departments = [{ id: 7, name: "Tobacco" }, { id: 8, name: "Grocery" }];
    renderSection(true);
    await userEvent.click(screen.getByText("+ Add close"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/^Gross sales/), "1250.50");
    await userEvent.type(within(dialog).getByLabelText(/^Cash tender/), "1000");
    await userEvent.type(within(dialog).getByLabelText("Tobacco sales"), "300");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add close" }));
    await waitFor(() => expect(upsertRegisterClose).toHaveBeenCalledTimes(1));
    const [day, body] = upsertRegisterClose.mock.calls[0];
    expect(day).toBe("2026-08-31");
    expect(body).toMatchObject({
      register_label: "Register 1",
      gross_sales: 1250.5,
      sales_tax: 0,
      cash_total: 1000,
      card_total: 0,
      other_total: 0,
      cash_counted: null,
      // A department left blank is not sent as a $0 line.
      department_sales: [{ department_id: 7, amount: 300 }],
    });
  });

  it("keeps a counted empty drawer as 0, not as uncounted", async () => {
    renderSection(true);
    await userEvent.click(screen.getByText("+ Add close"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Counted drawer cash"), "0");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add close" }));
    await waitFor(() => expect(upsertRegisterClose).toHaveBeenCalledTimes(1));
    expect(upsertRegisterClose.mock.calls[0][1].cash_counted).toBe(0);
  });

  it("prefills an existing close and saves it unchanged", async () => {
    renderSection(true);
    await userEvent.click(screen.getByText("Edit"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(upsertRegisterClose).toHaveBeenCalledTimes(1));
    expect(upsertRegisterClose.mock.calls[0][1]).toMatchObject({
      gross_sales: 1234.5,
      sales_tax: 98.76,
      cash_total: 800,
      card_total: 533.26,
      other_total: 0,
      cash_counted: 795,
    });
  });
});

describe("RegisterCloses delete", () => {
  beforeEach(() => {
    deleteRegisterClose.mockReset().mockResolvedValue(undefined);
  });

  it("asks first; Cancel deletes nothing, Delete deletes", async () => {
    renderSection(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Register 1 / Morning");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteRegisterClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteRegisterClose).toHaveBeenCalledWith(1));
    expect(await screen.findByText("Register close removed.")).toBeInTheDocument();
  });

  it("shows a refusal inside the dialog", async () => {
    deleteRegisterClose.mockRejectedValue(new Error("boom"));
    renderSection(true);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByText("Could not remove the close."))
      .toBeInTheDocument();
  });

  it("reads in Spanish, the add popup included", async () => {
    setLanguage("es");
    renderSection(true);
    expect(screen.getByText("Cajas")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(expect.arrayContaining(["Caja", "Bruto", "Contado", "Sobrante/faltante", "Departamento"]));
    expect(englishLeftovers(document.body, ["rc."])).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "+ Agregar cierre" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Caja")).toHaveValue("Caja 1");
    expect(within(dialog).getByPlaceholderText("Vacío = sin contar")).toBeInTheDocument();
    expect(englishLeftovers(dialog, ["rc."])).toEqual([]);
  });
});

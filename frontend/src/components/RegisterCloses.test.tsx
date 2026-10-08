import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RegisterCloses from "./RegisterCloses";
import { ToastProvider } from "./ui";

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
let departments: Array<{ id: number; name: string }> = [];

vi.mock("../api/dayclose", () => ({
  useDayClose: () => ({ data: summary, isLoading: false, isError: false }),
  useDepartments: () => ({ data: { departments } }),
  upsertRegisterClose: (...a: unknown[]) => upsertRegisterClose(...a),
  deleteRegisterClose: vi.fn(),
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

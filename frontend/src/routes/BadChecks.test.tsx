import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BadChecks from "./BadChecks";
import type { BadCheckDetail, BadCheckRow, CashedCheckRow } from "../api/checkCashing";
import { RecentChecks } from "../components/CheckActivity";
import { setLanguage } from "../i18n";
import { ApiError } from "../lib/api";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// Bad checks (CheckCashing INVARIANTS "Bad checks"): a manager marks a
// cashed check the bank sent back; the Bad checks page lists them,
// open first, with what is still owed; the bad check's popup records
// a payment (never more than what is left) and lets a manager write
// off the rest after saying why. Checked in Spanish too.

const api = vi.hoisted(() => ({
  useCheckDevice: vi.fn(),
  useBadChecks: vi.fn(),
  useBadCheck: vi.fn(),
  reportBadCheck: vi.fn(),
  addBadCheckPayment: vi.fn(),
  writeOffBadCheck: vi.fn(),
  voidCheck: vi.fn(),
  useCheckPictureBlob: vi.fn(),
}));

vi.mock("../api/checkCashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/checkCashing")>()),
  ...api,
}));

const CASHIER = ["check_cashing.create", "check_cashing.read", "check_cashing.update"];
const MANAGER = [...CASHIER, "check_cashing_manage.update"];

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, error: null, isFetching: false,
  refetch: vi.fn(),
});

const row: BadCheckRow = {
  id: 5, store_name: "Main St", cashed_check_id: 40, cashed_on: "2026-11-02",
  customer_id: 7, customer_name: "Persona Prueba", company_id: 3,
  company_name: "Acme Payroll", check_number: "1001", amount: 500,
  reason: "nsf", returned_on: "2026-11-09", fee: 25, owed: 525, paid: 200,
  balance: 325, status: "open", note: "Bank notice", write_off_note: "",
  created_at: "2026-11-09T15:00:00Z",
};

const cashedRow: CashedCheckRow = {
  id: 40, store_name: "Main St", store_day: "2026-11-02", created_at: "2026-11-02T15:00:00Z",
  customer_id: 7, customer_name: "Persona Prueba", company_id: 3,
  company_name: "Acme Payroll", check_number: "1001", check_date: null, amount: 500,
  fee: 10, cash: 490, status: "cashed", reason: "", void_reason: "",
  cashier_name: "Admin", warnings: [], approved: false, can_void: false,
  can_report_bad: false, bad_check: { id: 5, status: "open", reason: "nsf", balance: 325 },
};

function detail(over: Partial<BadCheckDetail> = {}): BadCheckDetail {
  return {
    bad_check: row, check: cashedRow,
    payments: [{
      id: 1, paid_on: "2026-11-10", amount: 200, note: "Cash", store_name: "Main St",
      taken_by: "Admin",
    }],
    can_pay: true, can_write_off: true, ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  signInAs({ permissions: [...TEST_ADMIN.permissions, ...MANAGER] });
  api.useCheckDevice.mockReturnValue(ok({
    state: "this", name: "Front counter", activated_at: "2026-11-09T10:00:00Z",
    activated_by: "Admin", last_seen_at: "2026-11-09T10:00:00Z",
  }));
  api.useBadChecks.mockReturnValue(ok({
    rows: [row], total: 1, page: 1, total_pages: 1, open_count: 1, open_owed: 325,
  }));
  api.useBadCheck.mockImplementation((id: number | null) => ok(id == null ? undefined : detail()));
  api.useCheckPictureBlob.mockReturnValue(ok(undefined));
});

describe("the Bad checks page", () => {
  it("lists open bad checks first with what is still owed", () => {
    renderRoute(<BadChecks />);
    expect(screen.getByRole("heading", { name: "Bad checks" })).toBeInTheDocument();
    expect(api.useBadChecks).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "open", q: "" }),
    );
    expect(screen.getByText("Open bad checks")).toBeInTheDocument();
    expect(screen.getAllByText("$325.00").length).toBeGreaterThan(1);
    expect(screen.getByText("Persona Prueba")).toBeInTheDocument();
    expect(screen.getByText("Not enough funds")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
  });

  it("switches tabs and searches as you type", async () => {
    renderRoute(<BadChecks />);
    await userEvent.click(screen.getByRole("tab", { name: "Paid back" }));
    expect(api.useBadChecks).toHaveBeenLastCalledWith(expect.objectContaining({ status: "paid" }));
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(api.useBadChecks).toHaveBeenLastCalledWith(expect.objectContaining({ status: "" }));
    await userEvent.type(screen.getByRole("searchbox"), "acme");
    await waitFor(() => expect(api.useBadChecks).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "acme" }),
    ));
  });

  it("says how a bad check gets here when there are none", () => {
    api.useBadChecks.mockReturnValue(ok({
      rows: [], total: 0, page: 1, total_pages: 1, open_count: 0, open_owed: 0,
    }));
    renderRoute(<BadChecks />);
    expect(screen.getByText("No bad checks")).toBeInTheDocument();
    expect(screen.getByText(/a manager marks it on the check/)).toBeInTheDocument();
  });

  it("opens a bad check with its payments", async () => {
    renderRoute(<BadChecks />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    expect(api.useBadCheck).toHaveBeenLastCalledWith(5);
    expect(within(dialog).getByText("Bad check: Persona Prueba")).toBeInTheDocument();
    expect(within(dialog).getByText(/Acme Payroll #1001 for \$500.00/)).toBeInTheDocument();
    expect(within(dialog).getByText("$525.00")).toBeInTheDocument();
    expect(within(dialog).getByText(/Cash/)).toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    renderRoute(<BadChecks />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    await screen.findByRole("dialog");
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("the bad check popup", () => {
  async function openIt() {
    renderRoute(<BadChecks />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    return screen.findByRole("dialog");
  }

  it("records a payment, never more than what is left", async () => {
    api.addBadCheckPayment.mockResolvedValue(detail());
    const dialog = await openIt();
    const amount = within(dialog).getByLabelText("Amount paid");
    await userEvent.type(amount, "400");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record payment" }));
    expect(within(dialog).getByText(/more than what is left \(\$325.00\)/)).toBeInTheDocument();
    expect(api.addBadCheckPayment).not.toHaveBeenCalled();
    await userEvent.clear(amount);
    await userEvent.type(amount, "100");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Cash");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(api.addBadCheckPayment).toHaveBeenCalledWith(5, {
      amount: 100, note: "Cash",
    }));
    expect(await screen.findByText("Payment recorded.")).toBeInTheDocument();
  });

  it("shows the server's refusal of a payment", async () => {
    api.addBadCheckPayment.mockRejectedValue(new ApiError(409, "This bad check is closed.", {}));
    const dialog = await openIt();
    await userEvent.type(within(dialog).getByLabelText("Amount paid"), "10");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record payment" }));
    expect(await within(dialog).findByText("This bad check is closed.")).toBeInTheDocument();
  });

  it("writes off the rest only after saying why", async () => {
    api.writeOffBadCheck.mockResolvedValue(detail());
    const dialog = await openIt();
    await userEvent.click(within(dialog).getByRole("button", { name: "Write off" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText(/\$325.00 still owed by Persona Prueba/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole("button", { name: "Write off" }));
    expect(within(confirm).getByText("Say why it is written off.")).toBeInTheDocument();
    expect(api.writeOffBadCheck).not.toHaveBeenCalled();
    await userEvent.type(within(confirm).getByLabelText("Why"), "Moved away");
    await userEvent.click(within(confirm).getByRole("button", { name: "Write off" }));
    await waitFor(() => expect(api.writeOffBadCheck).toHaveBeenCalledWith(5, "Moved away"));
    expect(await screen.findByText("Written off.")).toBeInTheDocument();
  });

  it("gives a cashier the payment form but no write off", async () => {
    api.useBadCheck.mockImplementation((id: number | null) => (
      ok(id == null ? undefined : detail({ can_write_off: false }))
    ));
    const dialog = await openIt();
    expect(within(dialog).getByRole("button", { name: "Record payment" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Write off" })).not.toBeInTheDocument();
  });

  it("is read only once closed, and says why it was written off", async () => {
    api.useBadCheck.mockImplementation((id: number | null) => (
      ok(id == null ? undefined : detail({
        bad_check: { ...row, status: "written_off", write_off_note: "Moved away" },
        can_pay: false, can_write_off: false,
      }))
    ));
    const dialog = await openIt();
    expect(within(dialog).getByText("Written off: Moved away")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Amount paid")).not.toBeInTheDocument();
  });

  it("shows a load error with a retry", async () => {
    api.useBadCheck.mockImplementation((id: number | null) => (id == null ? ok(undefined) : {
      ...ok(undefined), isError: true, error: new ApiError(500, "Boom", {}),
    }));
    const dialog = await openIt();
    expect(within(dialog).getByRole("button", { name: /Retry|Try again/ })).toBeInTheDocument();
  });
});

describe("marking a check bad from its row", () => {
  const fresh: CashedCheckRow = {
    ...cashedRow, bad_check: null, can_report_bad: true, can_void: true,
  };

  it("lets a manager mark a cashed check bad with the reason, date and fee", async () => {
    api.reportBadCheck.mockResolvedValue(detail());
    renderRoute(<RecentChecks rows={[fresh]} other="company" />);
    await userEvent.click(screen.getByRole("button", { name: "Mark bad" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/sent back the \$500.00 check of Persona Prueba/))
      .toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText("Why the bank sent it back"), "stop_payment");
    await userEvent.type(within(dialog).getByLabelText("Returned-check fee"), "25");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Notice 11/11");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as bad check" }));
    await waitFor(() => expect(api.reportBadCheck).toHaveBeenCalledWith(40, expect.objectContaining({
      reason: "stop_payment", fee: 25, note: "Notice 11/11",
    })));
    expect(await screen.findByText("Marked as a bad check.")).toBeInTheDocument();
  });

  it("shows the server's refusal inside the popup", async () => {
    api.reportBadCheck.mockRejectedValue(new ApiError(409, "This check is already a bad check.", {}));
    renderRoute(<RecentChecks rows={[fresh]} other="company" />);
    await userEvent.click(screen.getByRole("button", { name: "Mark bad" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as bad check" }));
    expect(await within(dialog).findByText("This check is already a bad check.")).toBeInTheDocument();
  });

  it("shows a bad check on its row and opens it", async () => {
    renderRoute(<RecentChecks rows={[cashedRow]} other="company" />);
    expect(screen.getByText(/Bad check · \$325.00 left/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark bad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View bad check" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(api.useBadCheck).toHaveBeenLastCalledWith(5);
  });

  it("offers no Mark bad without the manager's right", () => {
    renderRoute(<RecentChecks rows={[{ ...fresh, can_report_bad: false }]} other="company" />);
    expect(screen.queryByRole("button", { name: "Mark bad" })).not.toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    renderRoute(<RecentChecks rows={[fresh, { ...cashedRow, id: 41 }]} other="company" />);
    await userEvent.click(screen.getByRole("button", { name: "Marcar rebotado" }));
    await screen.findByRole("dialog");
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

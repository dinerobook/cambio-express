import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CashCheck from "./CashCheck";
import type {
  CheckCompanyDetail, CheckCustomerDetail, CheckReview,
} from "../api/checkCashing";
import { setLanguage } from "../i18n";
import { ApiError } from "../lib/api";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// Check cashing → Cash a check (api/Modules/CheckCashing/INVARIANTS.md
// "Cash a check"): the check's numbers find the company, its regulars
// pick the customer, the review decides what must be ticked or
// approved, the fee can be changed, and the payout asks first. A
// refusal is saved with its reason. Someone who may only look sees it
// all disabled. In Spanish too.

const api = vi.hoisted(() => ({
  useCheckDevice: vi.fn(),
  switchOffCheckDevice: vi.fn(),
  useCompanyLookup: vi.fn(),
  useCheckReview: vi.fn(),
  useCheckCompanies: vi.fn(),
  useCheckCustomers: vi.fn(),
  useCheckCompany: vi.fn(),
  useCheckCustomer: vi.fn(),
  useCompanyCustomers: vi.fn(),
  useCheckActivity: vi.fn(),
  cashCheck: vi.fn(),
  createCheckCompany: vi.fn(),
  createCheckCustomer: vi.fn(),
}));

vi.mock("../api/checkCashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/checkCashing")>()),
  ...api,
}));

const CASHIER = ["check_cashing.create", "check_cashing.read", "check_cashing.update"];
const MANAGER = [...CASHIER, "check_cashing_manage.update"];

function signIn(permissions: string[]) {
  signInAs({ permissions: [...TEST_ADMIN.permissions, ...permissions] });
}

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, error: null, isFetching: false,
  isSuccess: data !== undefined, refetch: vi.fn(),
});

const company = {
  id: 3, name: "Acme Payroll", routing_number: "021000021", account_number: "123456789",
  address: "", phone: "", status: "normal", status_reason: "", fee_kind: null,
  fee_value: null, notes: "", home_store_name: "",
} as CheckCompanyDetail;

const customer = {
  id: 7, full_name: "Ana Ruiz", dob: null, phone_country: "+1",
  phone_number: "3055550142", address: "", status: "normal", status_reason: "",
  fee_kind: null, fee_value: null, notes: "", home_store_name: "",
  ids: [{ id: 11, id_type: "drivers_license", id_number: "D1234567", issuer: "TX",
    expires_on: "2030-01-01", expired: false }],
} as CheckCustomerDetail;

function review(items: CheckReview["items"] = []): CheckReview {
  return {
    fee: { kind: "percent", value: 2, fee: 10, source: "store", base_applied: false },
    items, today_count: 0, today_total: 0,
  };
}

const item = (code: string, level: CheckReview["items"][number]["level"]) => ({
  code, level, count: null, amount: null, day: null,
});

let reviewData: CheckReview;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.useCheckDevice.mockReturnValue(ok({
    state: "this", name: "Front counter", activated_at: "2026-11-09T10:00:00Z",
    activated_by: "Admin", last_seen_at: "2026-11-09T10:00:00Z",
  }));
  signIn(MANAGER);
  reviewData = review();
  api.useCompanyLookup.mockImplementation((routing: string, account: string) => ok(
    routing.length === 9 && account
      ? { company: routing === company.routing_number ? company : null }
      : undefined,
  ));
  api.useCheckReview.mockImplementation((_body: unknown, enabled: boolean) => (
    ok(enabled ? reviewData : undefined)
  ));
  api.useCheckCompanies.mockReturnValue(ok({ rows: [], total: 0, page: 1, total_pages: 1 }));
  api.useCheckCustomers.mockReturnValue(ok({
    rows: [{ id: 7, full_name: "Ana Ruiz", phone_country: "+1", phone_number: "",
      id_summary: "••••4567", has_expired_id: false, status: "normal", home_store_name: "" }],
    total: 1, page: 1, total_pages: 1,
  }));
  api.useCheckCompany.mockImplementation((id?: number) => ok(id ? { company } : undefined));
  api.useCheckCustomer.mockImplementation((id?: number) => ok(id ? { customer } : undefined));
  api.useCompanyCustomers.mockImplementation((id?: number) => ok(id ? {
    rows: [{ id: 7, full_name: "Ana Ruiz", status: "normal", checks: 4, last_day: "2026-11-02" }],
  } : undefined));
  api.useCheckActivity.mockReturnValue(ok({ stats: [], recent: [] }));
});

async function fillCheck(amount = "500") {
  await userEvent.type(screen.getByLabelText("Routing number"), "021000021");
  await userEvent.type(screen.getByLabelText("Account number"), "123456789");
  await userEvent.type(screen.getByLabelText("Check number"), "1001");
  await userEvent.type(screen.getByLabelText(/^Check amount/), amount);
}

async function pickRegular() {
  await userEvent.click(await screen.findByRole("button", { name: /Ana Ruiz/ }));
  await screen.findByRole("link", { name: "Ana Ruiz" });
  // The review follows the typing after the 300 ms pause.
  await screen.findByText(/Suggested|Sugerida/);
}

const cashButton = () => screen.getByRole("button", { name: "Cash check" });

describe("cash a check", () => {
  it("finds the company by the check's numbers and picks a regular", async () => {
    renderRoute(<CashCheck />);
    expect(screen.getByRole("heading", { name: "Cash a check" })).toBeInTheDocument();
    await fillCheck();
    expect(await screen.findByRole("link", { name: "Acme Payroll" }))
      .toHaveAttribute("href", "/check-cashing/companies/3");
    expect(screen.getByText(/4 checks/)).toBeInTheDocument();
    await pickRegular();
    expect(screen.getByText("D1234567")).toBeInTheDocument();
  });

  it("pays after asking, with the suggested fee", async () => {
    api.cashCheck.mockResolvedValue({ check: {} });
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    await waitFor(() => expect(screen.getByTestId("cash-to-pay")).toHaveTextContent("$490.00"));
    expect(screen.getByText(/Suggested \$10\.00, the store's default fee/)).toBeInTheDocument();
    await waitFor(() => expect(cashButton()).toBeEnabled());
    await userEvent.click(cashButton());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Pay \$490\.00 in cash to Ana Ruiz/)).toBeInTheDocument();
    expect(api.cashCheck).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cash check" }));
    await waitFor(() => expect(api.cashCheck).toHaveBeenCalledWith({
      customer_id: 7, company_id: 3, check_number: "1001", check_date: null,
      amount: 500, fee: 10, acknowledged: [], decision: "cash", reason: "", micr: "",
    }));
    expect(await screen.findByText("Paid $490.00 to Ana Ruiz.")).toBeInTheDocument();
    // Ready for the next check.
    expect(screen.getByLabelText("Routing number")).toHaveValue("");
  });

  it("lets the cashier change the fee, never above the check", async () => {
    renderRoute(<CashCheck />);
    await fillCheck("50");
    await pickRegular();
    const fee = screen.getByLabelText(/^Fee/);
    await userEvent.clear(fee);
    await userEvent.type(fee, "4");
    await waitFor(() => expect(screen.getByTestId("cash-to-pay")).toHaveTextContent("$46.00"));
    await userEvent.clear(fee);
    await userEvent.type(fee, "60");
    expect(await screen.findByText("The fee cannot be more than the check.")).toBeInTheDocument();
    await waitFor(() => expect(cashButton()).toBeDisabled());
  });

  it("wants every warning ticked", async () => {
    reviewData = review([
      { ...item("cashed_today", "warn"), count: 1, amount: 300 },
      item("first_check", "info"),
    ]);
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    expect(screen.getByText("Already cashed 1 check today for $300.00.")).toBeInTheDocument();
    expect(screen.getByText("First check from this company.")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 350));
    expect(cashButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "I checked this" }));
    await waitFor(() => expect(cashButton()).toBeEnabled());
  });

  it("puts the worst first: a block before a note", async () => {
    reviewData = review([item("first_check", "info"), item("customer_blocked", "block")]);
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    const texts = screen.getAllByText(/This customer is blocked|First check/).map((n) => n.textContent);
    expect(texts[0]).toBe("This customer is blocked.");
    await new Promise((r) => setTimeout(r, 350));
    expect(cashButton()).toBeDisabled();
  });

  it("needs a manager for an approval", async () => {
    signIn(CASHIER);
    reviewData = review([{ ...item("duplicate", "approve"), day: "2026-11-01" }]);
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    expect(screen.getByText(/already cashed on Nov 1, 2026/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Manager approves" })).toBeDisabled();
    expect(await screen.findByText(/A manager must approve this check/)).toBeInTheDocument();
    expect(cashButton()).toBeDisabled();
  });

  it("lets a manager approve by ticking", async () => {
    reviewData = review([item("daily_limit", "approve")]);
    api.cashCheck.mockResolvedValue({ check: {} });
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    await userEvent.click(screen.getByRole("checkbox", { name: "Manager approves" }));
    await waitFor(() => expect(cashButton()).toBeEnabled());
    await userEvent.click(cashButton());
    await userEvent.click(within(await screen.findByRole("dialog"))
      .getByRole("button", { name: "Cash check" }));
    await waitFor(() => expect(api.cashCheck).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledged: ["daily_limit"] }),
    ));
  });

  it("shows the server's refusal inside the popup", async () => {
    api.cashCheck.mockRejectedValue(new ApiError(409, "Tick the warnings first: duplicate.", {}));
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    await waitFor(() => expect(cashButton()).toBeEnabled());
    await userEvent.click(cashButton());
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cash check" }));
    expect(await within(dialog).findByText("Tick the warnings first: duplicate."))
      .toBeInTheDocument();
  });

  it("saves a refusal with its reason", async () => {
    reviewData = review([item("customer_blocked", "block")]);
    api.cashCheck.mockResolvedValue({ check: {} });
    renderRoute(<CashCheck />);
    await fillCheck();
    await pickRegular();
    await userEvent.click(screen.getByRole("button", { name: "Do not accept" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Do not accept" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Why not?"), "Altered amount");
    await userEvent.click(confirm);
    await waitFor(() => expect(api.cashCheck).toHaveBeenCalledWith(expect.objectContaining({
      decision: "decline", reason: "Altered amount", fee: 0,
    })));
    expect(await screen.findByText("Saved as not accepted.")).toBeInTheDocument();
  });

  it("adds an unknown company with the check's numbers", async () => {
    api.createCheckCompany.mockResolvedValue({ company: { ...company, id: 9 } });
    renderRoute(<CashCheck />);
    await userEvent.type(screen.getByLabelText("Routing number"), "111000025");
    await userEvent.type(screen.getByLabelText("Account number"), "5555");
    expect(await screen.findByText(/No company on file has these/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New company" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/routing 111000025 and account ••••5555/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Company name"), "PD Electric");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add company" }));
    await waitFor(() => expect(api.createCheckCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "PD Electric", routing_number: "111000025", account_number: "5555",
      }),
    ));
    expect(await screen.findByRole("link", { name: "Acme Payroll" })).toBeInTheDocument();
  });

  it("finds a customer by search or adds one with an ID", async () => {
    api.createCheckCustomer.mockResolvedValue({ customer: { ...customer, id: 8 } });
    renderRoute(<CashCheck />);
    await userEvent.type(screen.getByLabelText(/^Find a customer/), "Ana");
    expect(await screen.findByRole("button", { name: /Ana Ruiz/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "New customer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Full name")).toHaveValue("Ana");
    const add = within(dialog).getByRole("button", { name: "Add customer" });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("ID number"), "D99");
    await userEvent.click(add);
    await waitFor(() => expect(api.createCheckCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        full_name: "Ana", ids: [expect.objectContaining({ id_number: "D99" })],
      }),
    ));
  });

  it("is view only without the right to cash", () => {
    signIn(["check_cashing.read"]);
    renderRoute(<CashCheck />);
    expect(screen.getByText(/You can look but not cash checks/)).toBeInTheDocument();
    expect(screen.getByLabelText("Routing number")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cash check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Do not accept" })).not.toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    reviewData = review([item("ctr_due", "info")]);
    renderRoute(<CashCheck />);
    expect(screen.getByRole("heading", { name: "Cambiar un cheque" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Número de ruta"), "021000021");
    await userEvent.type(screen.getByLabelText("Número de cuenta"), "123456789");
    await userEvent.type(screen.getByLabelText(/^Monto del cheque/), "12000");
    await screen.findByRole("link", { name: "Acme Payroll" });
    await pickRegular();
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

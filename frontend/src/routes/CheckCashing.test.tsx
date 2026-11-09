import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CheckCashingSettings from "./CheckCashingSettings";
import CheckCompanies from "./CheckCompanies";
import CheckCompanyForm from "./CheckCompanyForm";
import CheckCustomerForm from "./CheckCustomerForm";
import CheckCustomers from "./CheckCustomers";
import type {
  CheckCompanyDetail, CheckCustomerDetail, CheckSettings,
} from "../api/checkCashing";
import { filterNavForRole } from "../components/navConfig";
import { setLanguage } from "../i18n";
import { canAccess } from "../lib/access";
import { ApiError } from "../lib/api";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// Check cashing (standalone module behind the store's `check_desk`
// switch): the sidebar group and route rights, the two lists, the
// customer and company profiles (who may change status and fee, the
// required ID, removing an ID asks first), and the store settings.
// Every page is checked in Spanish too.

const api = vi.hoisted(() => ({
  useCheckSettings: vi.fn(),
  saveCheckSettings: vi.fn(),
  useCheckCustomers: vi.fn(),
  useCheckCustomer: vi.fn(),
  createCheckCustomer: vi.fn(),
  updateCheckCustomer: vi.fn(),
  addCheckCustomerId: vi.fn(),
  updateCheckCustomerId: vi.fn(),
  deleteCheckCustomerId: vi.fn(),
  useCheckCompanies: vi.fn(),
  useCheckCompany: vi.fn(),
  createCheckCompany: vi.fn(),
  updateCheckCompany: vi.fn(),
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
  refetch: vi.fn(),
});

const settings: CheckSettings = {
  default_fee_kind: "percent", default_fee_value: 2,
  base_charge: null, base_charge_under: null, expired_id_mode: "warn",
};

const customer: CheckCustomerDetail = {
  id: 7, full_name: "Ana Ruiz", dob: "1990-04-01", phone_country: "+1",
  phone_number: "3055550142", address: "1 Main St", status: "normal",
  status_reason: "", fee_kind: null, fee_value: null, notes: "",
  home_store_name: "", created_at: "2026-11-01T10:00:00Z",
  ids: [
    {
      id: 11, id_type: "drivers_license", id_number: "D1234567", issuer: "TX",
      expires_on: "2030-01-01", expired: false,
    },
    {
      id: 12, id_type: "passport", id_number: "P998877", issuer: "Mexico",
      expires_on: "2020-01-01", expired: true,
    },
  ],
} as CheckCustomerDetail;

const company: CheckCompanyDetail = {
  id: 3, name: "Acme Payroll", routing_number: "021000021", account_number: "123456789",
  address: "", phone: "", status: "trusted", status_reason: "", fee_kind: "flat",
  fee_value: 3, notes: "", home_store_name: "",
} as CheckCompanyDetail;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  signIn(MANAGER);
  api.useCheckSettings.mockReturnValue(ok(settings));
  api.useCheckCustomer.mockReturnValue(ok(undefined));
  api.useCheckCompany.mockReturnValue(ok(undefined));
  api.useCheckCustomers.mockReturnValue(ok({
    rows: [{
      id: 7, full_name: "Ana Ruiz", phone_country: "+1", phone_number: "3055550142",
      id_summary: "••••4567", has_expired_id: true, status: "blocked",
      home_store_name: "",
    }],
    total: 1, page: 1, total_pages: 1,
  }));
  api.useCheckCompanies.mockReturnValue(ok({
    rows: [{
      id: 3, name: "Acme Payroll", routing_number: "021000021", account_last4: "6789",
      status: "trusted", home_store_name: "",
    }],
    total: 1, page: 1, total_pages: 1,
  }));
});

describe("sidebar and route rights", () => {
  const labels = (role: string, perms: string[], flags: string[]) =>
    filterNavForRole(role, perms, flags)
      .find((g) => g.title === "Check cashing")?.items.map((i) => i.label) ?? [];

  it("shows the group only when the store's check_desk switch is on", () => {
    expect(labels("admin", MANAGER, [])).toEqual([]);
    expect(labels("admin", MANAGER, ["check_desk"]))
      .toEqual(["Check customers", "Check companies", "Check cashing settings"]);
  });

  it("gives a cashier the lists but not the settings", () => {
    expect(labels("employee", CASHIER, ["check_desk"]))
      .toEqual(["Check customers", "Check companies"]);
    expect(labels("employee", [], ["check_desk"])).toEqual([]);
  });

  it("keeps the old Returned checks item on its own flag", () => {
    const money = filterNavForRole("admin", ["return_checks.read"], ["module_check_cashing"])
      .flatMap((g) => g.items.map((i) => i.label));
    expect(money).toContain("Returned checks");
    expect(money).not.toContain("Check customers");
  });

  it("guards each route by its right", () => {
    signIn(CASHIER);
    expect(canAccess("/check-cashing/customers")).toBe(true);
    expect(canAccess("/check-cashing/companies/new")).toBe(true);
    expect(canAccess("/check-cashing/settings")).toBe(false);
    signIn(MANAGER);
    expect(canAccess("/check-cashing/settings")).toBe(true);
    signIn([]);
    expect(canAccess("/check-cashing/customers")).toBe(false);
  });
});

describe("lists", () => {
  it("lists customers with a masked ID, the expired flag and CSV export", () => {
    renderRoute(<CheckCustomers />);
    expect(screen.getByText("1 customer")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("Ana Ruiz")).toBeInTheDocument();
    expect(within(table).getByText("••••4567")).toBeInTheDocument();
    expect(within(table).getByText("ID expired")).toBeInTheDocument();
    expect(within(table).getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export CSV/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New customer" })).toBeInTheDocument();
  });

  it("opens a customer from the row", async () => {
    renderRoute(<CheckCustomers />);
    await userEvent.click(screen.getByRole("button", { name: "Open Ana Ruiz" }));
    expect(screen.getByText("Navigated to /check-cashing/customers/7")).toBeInTheDocument();
  });

  it("lists companies with only the last four of the account", () => {
    renderRoute(<CheckCompanies />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("021000021")).toBeInTheDocument();
    expect(within(table).getByText("••••6789")).toBeInTheDocument();
    expect(within(table).queryByText("123456789")).not.toBeInTheDocument();
  });

  it("hides New customer from someone who may only look", () => {
    signIn(["check_cashing.read"]);
    renderRoute(<CheckCustomers />);
    expect(screen.queryByRole("link", { name: "New customer" })).not.toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCustomers />);
    expect(screen.getByText("1 cliente")).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("new customer", () => {
  const at = { path: "/check-cashing/customers/new" };

  it("needs a name and an ID number, then sends the ID with the profile", async () => {
    api.createCheckCustomer.mockResolvedValue({ customer: { ...customer, id: 9 } });
    renderRoute(<CheckCustomerForm />, at);
    const save = screen.getByRole("button", { name: "Add customer" });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Full name"), "Ana Ruiz");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText("ID number"), "D1234567");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(api.createCheckCustomer).toHaveBeenCalledTimes(1));
    const body = api.createCheckCustomer.mock.calls[0][0];
    expect(body.full_name).toBe("Ana Ruiz");
    expect(body.ids).toEqual([expect.objectContaining({
      id_type: "drivers_license", id_number: "D1234567",
    })]);
    expect(await screen.findByText("Navigated to /check-cashing/customers/9")).toBeInTheDocument();
  });

  it("shows the server's refusal and stays on the page", async () => {
    api.createCheckCustomer.mockRejectedValue(new ApiError(422, "Add at least one ID.", {}));
    renderRoute(<CheckCustomerForm />, at);
    await userEvent.type(screen.getByLabelText("Full name"), "Ana");
    await userEvent.type(screen.getByLabelText("ID number"), "X1");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect(await screen.findByText("Add at least one ID.")).toBeInTheDocument();
  });

  it("lets a manager set the status and own fee", () => {
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Own fee")).toBeInTheDocument();
  });

  it("shows a cashier the status and fee without the fields", () => {
    signIn(CASHIER);
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.queryByLabelText("Status")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Own fee")).not.toBeInTheDocument();
    expect(screen.getByText("Own fee: —")).toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCustomerForm />, at);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("customer profile", () => {
  const at = { path: "/check-cashing/customers/:id", at: "/check-cashing/customers/7" };

  beforeEach(() => {
    api.useCheckCustomer.mockReturnValue(ok({ customer }));
  });

  it("lists the IDs, marks the expired one, and asks before removing", async () => {
    api.deleteCheckCustomerId.mockResolvedValue({ customer });
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.getByText("D1234567")).toBeInTheDocument();
    expect(screen.getByText("ID expired")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Remove ID" })[1]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Passport P998877/)).toBeInTheDocument();
    expect(api.deleteCheckCustomerId).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove ID" }));
    await waitFor(() => expect(api.deleteCheckCustomerId).toHaveBeenCalledWith(7, 12));
  });

  it("offers no Remove on the last ID", () => {
    api.useCheckCustomer.mockReturnValue(ok({ customer: { ...customer, ids: [customer.ids[0]] } }));
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.queryByRole("button", { name: "Remove ID" })).not.toBeInTheDocument();
    expect(screen.getByText(/always keeps at least one ID/)).toBeInTheDocument();
  });

  it("adds an ID through its own popup", async () => {
    api.addCheckCustomerId.mockResolvedValue({ customer });
    renderRoute(<CheckCustomerForm />, at);
    await userEvent.click(screen.getByRole("button", { name: "Add ID" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("ID number"), " S55 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save ID" }));
    await waitFor(() => expect(api.addCheckCustomerId).toHaveBeenCalledWith(
      7, expect.objectContaining({ id_number: "S55" }),
    ));
  });

  it("saves profile edits", async () => {
    api.updateCheckCustomer.mockResolvedValue({ customer: { ...customer, phone_number: "1" } });
    renderRoute(<CheckCustomerForm />, at);
    const save = screen.getByRole("button", { name: "Save changes" });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "1" } });
    await userEvent.click(save);
    await waitFor(() => expect(api.updateCheckCustomer).toHaveBeenCalledWith(
      7, expect.objectContaining({ phone_number: "1", status: "normal" }),
    ));
    expect(await screen.findByText("Customer saved")).toBeInTheDocument();
  });

  it("is view only without the edit right", () => {
    signIn(["check_cashing.read"]);
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.getByLabelText("Full name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add ID" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit ID" })).not.toBeInTheDocument();
  });

  it("shows a load error with a retry", () => {
    api.useCheckCustomer.mockReturnValue({
      ...ok(undefined), isError: true, error: new ApiError(404, "Customer not found.", {}),
    });
    renderRoute(<CheckCustomerForm />, at);
    expect(screen.getByText("Customer not found.")).toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCustomerForm />, at);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("company form", () => {
  const at = { path: "/check-cashing/companies/new" };

  it("keeps only digits, wants 9 for routing and both numbers or neither", async () => {
    renderRoute(<CheckCompanyForm />, at);
    await userEvent.type(screen.getByLabelText("Company name"), "Acme");
    const save = screen.getByRole("button", { name: "Add company" });
    expect(save).toBeEnabled();
    await userEvent.type(screen.getByLabelText(/^Routing number/), "02-100");
    expect(screen.getByLabelText(/^Routing number/)).toHaveValue("02100");
    expect(screen.getByText("A routing number has 9 digits.")).toBeInTheDocument();
    expect(screen.getByText(/Enter both the routing and the account number/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Routing number/), "0021");
    await userEvent.type(screen.getByLabelText(/^Account number/), "123456789");
    expect(save).toBeEnabled();
  });

  it("adds the company and opens its profile", async () => {
    api.createCheckCompany.mockResolvedValue({ company: { ...company, id: 5 } });
    renderRoute(<CheckCompanyForm />, at);
    await userEvent.type(screen.getByLabelText("Company name"), " Acme ");
    await userEvent.click(screen.getByRole("button", { name: "Add company" }));
    await waitFor(() => expect(api.createCheckCompany).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Acme", routing_number: "", account_number: "" }),
    ));
    expect(await screen.findByText("Navigated to /check-cashing/companies/5")).toBeInTheDocument();
  });

  it("shows a duplicate refusal from the server", async () => {
    api.createCheckCompany.mockRejectedValue(
      new ApiError(409, "Acme Payroll already has these numbers.", {}),
    );
    renderRoute(<CheckCompanyForm />, at);
    await userEvent.type(screen.getByLabelText("Company name"), "Acme");
    await userEvent.click(screen.getByRole("button", { name: "Add company" }));
    expect(await screen.findByText("Acme Payroll already has these numbers.")).toBeInTheDocument();
  });

  it("shows a cashier the company's status and fee read only", () => {
    signIn(CASHIER);
    api.useCheckCompany.mockReturnValue(ok({ company }));
    renderRoute(<CheckCompanyForm />, { path: "/check-cashing/companies/:id", at: "/check-cashing/companies/3" });
    expect(screen.getByLabelText("Company name")).toHaveValue("Acme Payroll");
    expect(screen.queryByLabelText("Own fee")).not.toBeInTheDocument();
    expect(screen.getByText("Own fee: $3.00")).toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCompanyForm />, at);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("settings", () => {
  it("saves the default fee with no base charge", async () => {
    api.saveCheckSettings.mockResolvedValue(settings);
    renderRoute(<CheckCashingSettings />);
    await userEvent.selectOptions(screen.getByLabelText(/^When a customer's ID has expired/), "block");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.saveCheckSettings).toHaveBeenCalledWith({
      default_fee_kind: "percent", default_fee_value: 2,
      base_charge: null, base_charge_under: null, expired_id_mode: "block",
    }));
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
  });

  it("shows the base charge fields only when switched on, and wants both amounts", async () => {
    renderRoute(<CheckCashingSettings />);
    expect(screen.queryByLabelText(/^Base charge/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch"));
    expect(screen.getByLabelText(/^Base charge/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  it("shows the server's refusal", async () => {
    api.saveCheckSettings.mockRejectedValue(new ApiError(403, "You do not have access.", {}));
    renderRoute(<CheckCashingSettings />);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("You do not have access.")).toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderRoute(<CheckCashingSettings />);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

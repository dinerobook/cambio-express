import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CheckCompliance from "./CheckCompliance";
import type { CheckCustomerDetail, CtrDetail, CtrRow } from "../api/checkCashing";
import { CtrDetailsCard, TinValue } from "../components/CtrDetails";
import { setLanguage } from "../i18n";
import { canAccess } from "../lib/access";
import { ApiError } from "../lib/api";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// Currency Transaction Reports (CheckCashing INVARIANTS "CTR"): the
// Compliance page lists the reports, soonest deadline first, for the
// manager only; a report opens with what FinCEN asks for and takes the
// 14-digit BSA ID once filed. A customer's CTR details (SSN / ITIN
// masked, a manager reveals it) are filled from the profile or the
// counter. Fictional people only. Checked in Spanish too.

const api = vi.hoisted(() => ({
  useCheckDevice: vi.fn(),
  useCtrs: vi.fn(),
  useCtr: vi.fn(),
  fileCtr: vi.fn(),
  saveCtrDetails: vi.fn(),
  revealTin: vi.fn(),
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

const row: CtrRow = {
  id: 9, customer_id: 7, customer_name: "Persona Prueba", store_day: "2026-11-12",
  kind: "ctr", cash: 10_450, check_count: 2, status: "to_file", due_on: "2026-11-27",
  overdue: false, bsa_id: "", filed_on: null, store_name: "Main St",
};

function report(over: Partial<CtrDetail> = {}): CtrDetail {
  return {
    row,
    filer: {
      legal_name: "Cambios Prueba LLC", dba_name: "Main St", ein: "123456789",
      street: "1 Test Ave", city: "Laredo", state: "TX", zip_code: "78040",
      contact_name: "Gerente Prueba", contact_phone: "9565550100", msb_registration: "",
      missing: [],
    },
    person: {
      full_name: "Persona Prueba", dob: "1990-04-01", tin_type: "ssn",
      tin_masked: "•••-••-6789", occupation: "Welder", address: "2 Sample Rd",
      city: "Laredo", state: "TX", zip_code: "78041", country: "US", gender: "",
      phone: "+19565550142", id_type: "drivers_license", id_number: "X0000000",
      id_issuer: "TX", missing: [],
    },
    checks: [
      {
        id: 40, store_name: "Main St", company_name: "Acme Payroll", check_number: "1001",
        amount: 6_000, fee: 120, cash: 5_880, created_at: "2026-11-12T15:00:00Z",
      },
      {
        id: 41, store_name: "Main St", company_name: "Acme Payroll", check_number: "1002",
        amount: 4_663.27, fee: 93.27, cash: 4_570, created_at: "2026-11-12T16:00:00Z",
      },
    ],
    gto_mark: "", filed_by: "",
    ...over,
  };
}

const customer: CheckCustomerDetail = {
  id: 7, full_name: "Persona Prueba", dob: null, phone_country: "+1",
  phone_number: "9565550142", address: "", status: "normal",
  status_reason: "", fee_kind: null, fee_value: null, notes: "",
  home_store_name: "", created_at: "2026-11-01T10:00:00Z",
  tin_type: "", tin_masked: "", occupation: "", city: "", state: "", zip_code: "",
  country: "US", gender: "",
  ctr_missing: ["dob", "tin", "occupation", "address", "city", "state", "zip_code"],
  ids: [], stats: [], recent_checks: [], photo_picture_id: null,
} as unknown as CheckCustomerDetail;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  signInAs({ permissions: [...TEST_ADMIN.permissions, ...MANAGER] });
  api.useCheckDevice.mockReturnValue(ok({
    state: "this", name: "Front counter", activated_at: "2026-11-09T10:00:00Z",
    activated_by: "Admin", last_seen_at: "2026-11-09T10:00:00Z",
  }));
  api.useCtrs.mockReturnValue(ok({
    rows: [row], total: 1, page: 1, total_pages: 1,
    counts: { to_file: 1, overdue: 0, due_soon: 0 },
  }));
  api.useCtr.mockImplementation((id: number | null) => ok(id == null ? undefined : { ctr: report() }));
});

describe("who opens Compliance", () => {
  it("is the manager's page, not the cashier's", () => {
    expect(canAccess("/check-cashing/compliance")).toBe(true);
    signInAs({ permissions: [...TEST_ADMIN.permissions, ...CASHIER] });
    expect(canAccess("/check-cashing/compliance")).toBe(false);
  });
});

describe("the Compliance page", () => {
  it("lists reports to file first, with the deadline", () => {
    renderRoute(<CheckCompliance />);
    expect(screen.getByRole("heading", { name: "Compliance" })).toBeInTheDocument();
    expect(api.useCtrs).toHaveBeenLastCalledWith(expect.objectContaining({ status: "to_file", q: "" }));
    expect(screen.getByText("Persona Prueba")).toBeInTheDocument();
    expect(screen.getByText("$10,450.00")).toBeInTheDocument();
    expect(screen.getByText(/bsaefiling.fincen.treas.gov/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeInTheDocument();
  });

  it("flags an overdue report", () => {
    api.useCtrs.mockReturnValue(ok({
      rows: [{ ...row, overdue: true }], total: 1, page: 1, total_pages: 1,
      counts: { to_file: 1, overdue: 1, due_soon: 1 },
    }));
    renderRoute(<CheckCompliance />);
    expect(screen.getAllByText("Overdue").length).toBeGreaterThan(1);
  });

  it("switches tabs and searches as you type", async () => {
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByRole("tab", { name: "Filed" }));
    expect(api.useCtrs).toHaveBeenLastCalledWith(expect.objectContaining({ status: "filed" }));
    await userEvent.click(screen.getByRole("tab", { name: "All" }));
    expect(api.useCtrs).toHaveBeenLastCalledWith(expect.objectContaining({ status: "" }));
    await userEvent.type(screen.getByRole("searchbox"), "test");
    await waitFor(() => expect(api.useCtrs).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: "test" }),
    ));
  });

  it("says when a report shows up when there are none", () => {
    api.useCtrs.mockReturnValue(ok({
      rows: [], total: 0, page: 1, total_pages: 1,
      counts: { to_file: 0, overdue: 0, due_soon: 0 },
    }));
    renderRoute(<CheckCompliance />);
    expect(screen.getByText("No reports")).toBeInTheDocument();
    expect(screen.getByText(/goes over \$10,000/)).toBeInTheDocument();
  });

  it("opens a report with the filer, the person and the checks", async () => {
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    expect(api.useCtr).toHaveBeenLastCalledWith(9);
    expect(within(dialog).getByText("CTR for Persona Prueba")).toBeInTheDocument();
    expect(within(dialog).getByText("Cambios Prueba LLC")).toBeInTheDocument();
    expect(within(dialog).getByText("•••-••-6789")).toBeInTheDocument();
    expect(within(dialog).getByText("$4,570.00")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Show" })).toBeInTheDocument();
  });

  it("warns about missing filer and person details, and the GTO mark", async () => {
    api.useCtr.mockImplementation((id: number | null) => ok(id == null ? undefined : {
      ctr: report({
        filer: { ...report().filer, ein: "", missing: ["ein"] },
        person: { ...report().person, occupation: "", missing: ["occupation"] },
        gto_mark: "MSB0926GTO",
      }),
    }));
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Missing in Settings: EIN.")).toBeInTheDocument();
    expect(within(dialog).getByText("Missing for the report: Occupation.")).toBeInTheDocument();
    expect(within(dialog).getByText(/write MSB0926GTO in item 2/)).toBeInTheDocument();
  });

  it("marks a report filed only with a 14-digit BSA ID", async () => {
    api.fileCtr.mockResolvedValue({ ctr: report() });
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "Mark as filed" });
    const bsa = within(dialog).getByLabelText("BSA ID");
    await userEvent.type(bsa, "31000-1234");
    expect(button).toBeDisabled();
    await userEvent.clear(bsa);
    await userEvent.type(bsa, "31000123456789");
    expect(button).toBeEnabled();
    fireEvent.change(within(dialog).getByLabelText("Filed on"), { target: { value: "2026-11-14" } });
    await userEvent.click(button);
    await waitFor(() => expect(api.fileCtr).toHaveBeenCalledWith(9, expect.objectContaining({
      bsa_id: "31000123456789",
    })));
    expect(await screen.findByText("Report marked as filed.")).toBeInTheDocument();
  });

  it("shows the server's refusal of a filing", async () => {
    api.fileCtr.mockRejectedValue(new ApiError(409, "This report is already filed.", {}));
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("BSA ID"), "31000123456789");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as filed" }));
    expect(await within(dialog).findByText("This report is already filed.")).toBeInTheDocument();
  });

  it("is read only once filed and names the BSA ID", async () => {
    api.useCtr.mockImplementation((id: number | null) => ok(id == null ? undefined : {
      ctr: report({
        row: { ...row, status: "filed", bsa_id: "31000123456789", filed_on: "2026-11-14" },
        filed_by: "Gerente Prueba",
      }),
    }));
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Filed with BSA ID 31000123456789/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("BSA ID")).not.toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    renderRoute(<CheckCompliance />);
    await userEvent.click(screen.getByText("Persona Prueba"));
    await screen.findByRole("dialog");
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("the SSN / ITIN", () => {
  it("shows masked, and a manager reveals it", async () => {
    api.revealTin.mockResolvedValue({ tin_type: "ssn", tin: "123456789" });
    renderRoute(<TinValue customerId={7} masked="•••-••-6789" type="ssn" />);
    expect(screen.getByText("•••-••-6789")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("123456789")).toBeInTheDocument();
    expect(api.revealTin).toHaveBeenCalledWith(7);
    expect(screen.queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
  });

  it("offers no reveal to a cashier", () => {
    signInAs({ permissions: [...TEST_ADMIN.permissions, ...CASHIER] });
    renderRoute(<TinValue customerId={7} masked="•••-••-6789" type="ssn" />);
    expect(screen.queryByRole("button", { name: "Show" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal of a reveal", async () => {
    api.revealTin.mockRejectedValue(new ApiError(409, "Set CHECK_PII_KEY first.", {}));
    renderRoute(<TinValue customerId={7} masked="•••-••-6789" type="ssn" />);
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Set CHECK_PII_KEY first.")).toBeInTheDocument();
  });
});

describe("a customer's CTR details", () => {
  it("lists what is missing and saves the details from the profile", async () => {
    api.saveCtrDetails.mockResolvedValue({ customer });
    renderRoute(<CtrDetailsCard customer={customer} />);
    expect(screen.getByText(/Missing for the report: Date of birth, SSN or ITIN/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: /CTR/ });
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Date of birth"), { target: { value: "1990-04-01" } });
    await userEvent.type(within(dialog).getByLabelText("SSN or ITIN"), "123456789");
    await userEvent.type(within(dialog).getByLabelText("Occupation"), "Welder");
    await userEvent.type(within(dialog).getByLabelText("Street"), "2 Sample Rd");
    await userEvent.type(within(dialog).getByLabelText("City"), "Laredo");
    await userEvent.type(within(dialog).getByLabelText("State"), "tx");
    await userEvent.type(within(dialog).getByLabelText("ZIP code"), "78041");
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(api.saveCtrDetails).toHaveBeenCalledWith(7, {
      dob: "1990-04-01", tin_type: "ssn", tin: "123456789", occupation: "Welder",
      address: "2 Sample Rd", city: "Laredo", state: "TX", zip_code: "78041",
      country: "US", gender: "",
    }));
    expect(await screen.findByText("CTR details saved.")).toBeInTheDocument();
  });

  it("keeps the number on file when the box is left empty", async () => {
    const filled = {
      ...customer, dob: "1990-04-01", tin_type: "ssn", tin_masked: "•••-••-6789",
      occupation: "Welder", address: "2 Sample Rd", city: "Laredo", state: "TX",
      zip_code: "78041", ctr_missing: [],
    } as CheckCustomerDetail;
    api.saveCtrDetails.mockResolvedValue({ customer: filled });
    renderRoute(<CtrDetailsCard customer={filled} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: /CTR/ });
    expect(within(dialog).getByText(/On file: •••-••-6789/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveCtrDetails).toHaveBeenCalledWith(7, expect.objectContaining({
      tin: "",
    })));
  });

  it("shows the server's refusal inside the popup", async () => {
    api.saveCtrDetails.mockRejectedValue(new ApiError(422, "An SSN is 9 digits.", {}));
    const filled = {
      ...customer, dob: "1990-04-01", tin_masked: "•••-••-6789", occupation: "Welder",
      address: "2 Sample Rd", city: "Laredo", state: "TX", zip_code: "78041", ctr_missing: [],
    } as CheckCustomerDetail;
    renderRoute(<CtrDetailsCard customer={filled} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: /CTR/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("An SSN is 9 digits.")).toBeInTheDocument();
  });

  it("offers no edit without the edit right", () => {
    signInAs({ permissions: [...TEST_ADMIN.permissions, "check_cashing.read"] });
    renderRoute(<CtrDetailsCard customer={customer} />);
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    renderRoute(<CtrDetailsCard customer={customer} />);
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    await screen.findByRole("dialog", { name: /CTR/ });
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

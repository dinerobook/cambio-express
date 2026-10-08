import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BankRules from "./BankRules";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Bank rules (BankSync INVARIANTS: AND conditions, first match wins
// in priority order, create may apply to existing rows, the apply
// report is {tagged, booked, locked_skipped}). Covers the page and
// the shared BankRuleForm it opens:
//   - A rule reads as a sentence; the list order IS the priority.
//   - Reorder posts the full new id order; hidden without update
//     rights and while a search filters the list.
//   - Create sends the typed conditions (dollars -> cents) and shows
//     what "apply to existing" did, including locked-day skips.
//   - Delete asks first, and a refusal is reported, not swallowed.
//   - Every control is gated on its own bank_sync.* right.

const createRule = vi.fn();
const updateRule = vi.fn();
const applyRule = vi.fn();
const reorderRules = vi.fn();
const toggleRule = vi.fn();
const deleteRule = vi.fn();
const refetch = vi.fn();
const useBankRules = vi.fn();

vi.mock("../api/bankSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/bankSync")>();
  return {
    ...real,
    createRule: (...a: unknown[]) => createRule(...a),
    updateRule: (...a: unknown[]) => updateRule(...a),
    applyRule: (...a: unknown[]) => applyRule(...a),
    reorderRules: (...a: unknown[]) => reorderRules(...a),
    toggleRule: (...a: unknown[]) => toggleRule(...a),
    deleteRule: (...a: unknown[]) => deleteRule(...a),
    useBankRules: (...a: unknown[]) => useBankRules(...a),
    useBankAccounts: () => ({
      data: { rows: [{ id: 7, label: "MSB ••0230" }] },
      isLoading: false, isError: false,
    }),
    useBankCategories: () => ({
      data: {
        groups: [
          {
            label: "Daily book", posts_to_daily: true,
            options: [{ slug: "check_deposit", label: "Check deposit" }],
          },
          {
            label: "Other", posts_to_daily: false,
            options: [{ slug: "bank_charge_0230", label: "Bank charge 0230" }],
          },
        ],
      },
      isLoading: false, isError: false,
    }),
  };
});

const baseRule = {
  priority: 100, desc_match_type: "contains", desc_match_value: "",
  sign_filter: "", amount_min_cents: null, amount_max_cents: null,
  account_filter_id: null, account_filter_label: "", auto_post: false,
  post_date_offset_days: 0, description: "", match_count: 0,
  last_matched_at: "",
};
const ruleOne = {
  ...baseRule, id: 1, enabled: true, priority: 1,
  desc_match_value: "REMOTE DEPOSIT", sign_filter: "credit",
  target_kind: "check_deposit", auto_post: true,
  description: "Remote deposits", match_count: 4,
};
const ruleTwo = {
  ...baseRule, id: 2, enabled: false, priority: 2,
  desc_match_value: "WIRE FEE", sign_filter: "debit",
  amount_min_cents: 500, target_kind: "bank_charge_0230",
  account_filter_id: 7, account_filter_label: "MSB ••0230",
};

function setRules(rows: unknown[], extra: Record<string, unknown> = {}) {
  useBankRules.mockReturnValue({
    data: { rows, total: rows.length },
    isLoading: false, isError: false, refetch, ...extra,
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <BankRules />
      </MemoryRouter>
    </ToastProvider>,
  );
}

function ruleRows() {
  return screen.getAllByRole("listitem").filter((el) => el.textContent?.includes("Categorize as"));
}

function rowFor(text: string) {
  const li = ruleRows().find((el) => el.textContent?.includes(text));
  if (!li) throw new Error(`no rule row containing ${text}`);
  return li;
}

function asRole(permissions: string[]) {
  setCurrentIdentity({ ...TEST_ADMIN, role: "employee", permissions });
}

beforeEach(() => {
  for (const fn of [
    createRule, updateRule, applyRule, reorderRules, toggleRule, deleteRule,
    refetch, useBankRules,
  ]) fn.mockReset();
  refetch.mockResolvedValue({});
  reorderRules.mockResolvedValue({ rows: [], total: 0 });
  toggleRule.mockResolvedValue({});
  deleteRule.mockResolvedValue(undefined);
  setRules([ruleOne, ruleTwo]);
});

describe("Bank rules list", () => {
  it("reads each rule as a sentence in priority order", () => {
    renderPage();
    expect(screen.getByText("2 rules")).toBeInTheDocument();
    const first = rowFor("Remote deposits");
    expect(within(first).getByText("“REMOTE DEPOSIT”")).toBeInTheDocument();
    expect(within(first).getByText("money in")).toBeInTheDocument();
    expect(within(first).getByText("Check deposit")).toBeInTheDocument();
    expect(within(first).getByText("books on daily book")).toBeInTheDocument();
    expect(within(first).getByText("4 matches")).toBeInTheDocument();

    const second = rowFor("WIRE FEE");
    expect(within(second).getByText("money out")).toBeInTheDocument();
    expect(within(second).getByText("$5.00")).toBeInTheDocument();
    expect(within(second).getByText("Bank charge 0230")).toBeInTheDocument();
    expect(within(second).getByText("off")).toBeInTheDocument();
    expect(second).toHaveTextContent("0 matches · MSB ••0230");
    // Neither rule books, so no pill on the second.
    expect(within(second).queryByText("books on daily book")).not.toBeInTheDocument();
  });

  it("shows an empty state with no rules", () => {
    setRules([]);
    renderPage();
    expect(screen.getByText("No rules yet")).toBeInTheDocument();
  });

  it("shows a retryable error when the rules fail to load", async () => {
    setRules([], { isError: true });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it("filters by search and says when nothing matches", async () => {
    renderPage();
    const search = screen.getByLabelText("Search rules");
    await userEvent.type(search, "wire");
    expect(ruleRows()).toHaveLength(1);
    expect(screen.queryByText("Remote deposits")).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(screen.getByText("No rules match that search.")).toBeInTheDocument();
  });
});

describe("Bank rules ordering", () => {
  it("posts the full new order when a rule moves down", async () => {
    renderPage();
    await userEvent.click(within(rowFor("Remote deposits")).getByTitle("Move down"));
    await waitFor(() => expect(reorderRules).toHaveBeenCalledWith([2, 1]));
    expect(refetch).toHaveBeenCalled();
  });

  it("posts the new order when a rule moves up, and pins the ends", async () => {
    renderPage();
    expect(within(rowFor("Remote deposits")).getByTitle("Move up")).toBeDisabled();
    expect(within(rowFor("WIRE FEE")).getByTitle("Move down")).toBeDisabled();
    await userEvent.click(within(rowFor("WIRE FEE")).getByTitle("Move up"));
    await waitFor(() => expect(reorderRules).toHaveBeenCalledWith([2, 1]));
  });

  it("reports a refused reorder", async () => {
    reorderRules.mockRejectedValue(new ApiError(409, "Rules changed, reload.", null));
    renderPage();
    await userEvent.click(within(rowFor("Remote deposits")).getByTitle("Move down"));
    expect(await screen.findByText("Rules changed, reload.")).toBeInTheDocument();
  });

  it("hides the move controls while a search filters the list", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Search rules"), "rule");
    expect(screen.queryByTitle("Move up")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Move down")).not.toBeInTheDocument();
  });

  it("hides the move controls without bank_sync.update", () => {
    asRole(["bank_sync.read"]);
    renderPage();
    expect(ruleRows()).toHaveLength(2);
    expect(screen.queryByTitle("Move up")).not.toBeInTheDocument();
  });
});

describe("Bank rule actions", () => {
  it("applies a rule now and reports tagged / booked / locked", async () => {
    applyRule.mockResolvedValue({
      rule: ruleOne, applied: { tagged: 5, booked: 3, locked_skipped: 1 },
    });
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Apply now" }),
    );
    expect(applyRule).toHaveBeenCalledWith(1);
    expect(await screen.findByText(
      "Rule applied. 5 tagged, 3 booked on the daily book, 1 skipped (day locked).",
    )).toBeInTheDocument();
  });

  it("cannot apply a disabled rule", () => {
    renderPage();
    expect(
      within(rowFor("WIRE FEE")).getByRole("button", { name: "Apply now" }),
    ).toBeDisabled();
  });

  it("toggles a rule", async () => {
    renderPage();
    await userEvent.click(
      within(rowFor("WIRE FEE")).getByRole("button", { name: "Enable" }),
    );
    expect(toggleRule).toHaveBeenCalledWith(2, true);
    expect(await screen.findByText("Rule enabled.")).toBeInTheDocument();
  });

  it("shows the server's reason when applying fails", async () => {
    applyRule.mockRejectedValue(new ApiError(500, "Bank feed down.", null));
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Apply now" }),
    );
    expect(await screen.findByText("Bank feed down.")).toBeInTheDocument();
  });

  it("asks before deleting, and deletes on confirm", async () => {
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Delete rule/);
    expect(dialog).toHaveTextContent(/Transactions it already tagged keep their category/);
    expect(deleteRule).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith(1));
    expect(await screen.findByText("Rule deleted.")).toBeInTheDocument();
  });

  it("keeps the rule when the delete prompt is cancelled", async () => {
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteRule).not.toHaveBeenCalled();
  });

  it("reports a refused delete instead of failing silently", async () => {
    deleteRule.mockRejectedValue(new ApiError(403, "Not allowed.", null));
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Delete" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Not allowed.")).toBeInTheDocument();
  });
});

describe("Bank rule form", () => {
  async function openCreate() {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Create rule" }));
    return screen.findByRole("dialog");
  }

  it("creates a rule from the typed conditions and shows the apply result", async () => {
    createRule.mockResolvedValue({
      rule: ruleOne, applied: { tagged: 3, booked: 2, locked_skipped: 1 },
    });
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByLabelText("Description match text"), "  WIRE IN ");
    await userEvent.selectOptions(within(dialog).getByLabelText("Direction"), "credit");
    await userEvent.type(within(dialog).getByLabelText(/Amount at least/), "100.25");
    await userEvent.selectOptions(within(dialog).getByLabelText("Account"), "7");
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "check_deposit",
    );
    await userEvent.type(within(dialog).getByLabelText("Rule name (optional)"), "Wires");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create rule" }));

    await waitFor(() => expect(createRule).toHaveBeenCalledTimes(1));
    expect(createRule).toHaveBeenCalledWith({
      enabled: true, priority: 100,
      desc_match_type: "contains", desc_match_value: "WIRE IN",
      sign_filter: "credit",
      amount_min_cents: 10025, amount_max_cents: null,
      account_filter_id: 7,
      target_kind: "check_deposit",
      auto_post: true, post_date_offset_days: 0,
      description: "Wires", apply_to_existing: true,
    });
    expect(await screen.findByText(
      "Rule created. 3 tagged, 2 booked on the daily book, 1 skipped (day locked).",
    )).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("only offers the booking options for a daily-book category", async () => {
    const dialog = await openCreate();
    expect(within(dialog).queryByText("Also book it on the daily book")).not.toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "bank_charge_0230",
    );
    expect(within(dialog).queryByText("Also book it on the daily book")).not.toBeInTheDocument();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "check_deposit",
    );
    expect(within(dialog).getByText("Also book it on the daily book")).toBeInTheDocument();
    expect(within(dialog).getByText("Book it on")).toBeInTheDocument();
  });

  it("can skip applying to existing transactions", async () => {
    createRule.mockResolvedValue({ rule: ruleOne, applied: null });
    const dialog = await openCreate();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "bank_charge_0230",
    );
    await userEvent.click(
      within(dialog).getByLabelText("Apply to existing uncategorized transactions now"),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create rule" }));
    await waitFor(() => expect(createRule).toHaveBeenCalled());
    expect(createRule.mock.calls[0][0].apply_to_existing).toBe(false);
    expect(await screen.findByText("Rule created.")).toBeInTheDocument();
  });

  it("shows a field-level server refusal on its field", async () => {
    createRule.mockRejectedValue(new ApiError(422, "Invalid", {
      detail: { field: "amount_max_cents", message: "Max must exceed min." },
    }));
    const dialog = await openCreate();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "bank_charge_0230",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create rule" }));
    expect(await within(dialog).findByText("Max must exceed min.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a general server refusal and keeps the form open", async () => {
    createRule.mockRejectedValue(new ApiError(500, "Could not save rule.", null));
    const dialog = await openCreate();
    await userEvent.selectOptions(
      within(dialog).getByLabelText("Categorize as"), "bank_charge_0230",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create rule" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not save rule.");
  });

  it("edits an existing rule through the same form", async () => {
    updateRule.mockResolvedValue({ rule: ruleOne, applied: null });
    renderPage();
    await userEvent.click(
      within(rowFor("Remote deposits")).getByRole("button", { name: "Edit" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Description match text")).toHaveValue("REMOTE DEPOSIT");
    expect(within(dialog).getByLabelText("Categorize as")).toHaveValue("check_deposit");
    // No "apply to existing" on edit.
    expect(within(dialog).queryByLabelText(/Apply to existing/)).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(updateRule).toHaveBeenCalledTimes(1));
    expect(updateRule.mock.calls[0][0]).toBe(1);
    expect(await screen.findByText("Rule updated.")).toBeInTheDocument();
  });
});

describe("Bank rules permissions", () => {
  it("read-only: sees rules but no create or row actions", () => {
    asRole(["bank_sync.read"]);
    renderPage();
    expect(screen.getByText("Remote deposits")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create rule" })).not.toBeInTheDocument();
    for (const name of ["Edit", "Apply now", "Enable", "Disable", "Delete"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("update without delete: no Delete action", () => {
    asRole(["bank_sync.read", "bank_sync.update"]);
    renderPage();
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create rule" })).not.toBeInTheDocument();
  });

  it("create without update: Create rule only", () => {
    asRole(["bank_sync.read", "bank_sync.create"]);
    renderPage();
    expect(screen.getByRole("button", { name: "Create rule" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminBankRuleTemplates from "./SuperadminBankRuleTemplates";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// Superadmin rule templates (BankSync INVARIANTS "Rule templates"):
//   - every template reads as its rule sentence; a hidden one says off;
//   - New / Edit open the shared BankRuleForm in template mode (a
//     required name, no account, the every-store categories) and
//     send the template body;
//   - a server refusal lands on its field and nothing closes;
//   - Delete asks first and a failure is reported, not swallowed;
//   - a failed load offers a retry.

const LIST = "GET /api/v2/superadmin/bank-rule-templates";
const CATS = "GET /api/v2/superadmin/bank-rule-templates/categories";

const commission = {
  id: 9, name: "Intermex commission deposit", enabled: true,
  desc_match_type: "contains", desc_match_value: "INTERMEX COMM",
  sign_filter: "credit", amount_min_cents: null, amount_max_cents: null,
  target_kind: "pl_mt_commission_in_bank",
  target_label: "Money transfer commission in bank",
  auto_post: false, post_date_offset_days: 0, updated_at: "",
};
const hidden = {
  ...commission, id: 10, name: "Wire fee", enabled: false,
  desc_match_value: "WIRE FEE", sign_filter: "debit",
  target_kind: "pl_other_taxes", target_label: "Other taxes",
};

const categories = {
  groups: [
    { label: "Daily book", posts_to_daily: true,
      options: [{ slug: "check_deposit", label: "Check deposit" }] },
    { label: "Monthly P&L", posts_to_daily: false,
      options: [
        { slug: "pl_mt_commission_in_bank", label: "Money transfer commission in bank" },
        { slug: "pl_other_taxes", label: "Other taxes" },
      ] },
  ],
};

function setup(routes: Record<string, MockHandler> = {}) {
  const calls = mockFetch({
    [LIST]: { body: { rows: [commission, hidden], total: 2 } },
    [CATS]: { body: categories },
    ...routes,
  });
  renderRoute(<SuperadminBankRuleTemplates />);
  return calls;
}

function rowFor(name: string) {
  const li = screen.getAllByRole("listitem").find((el) => el.textContent?.includes(name));
  if (!li) throw new Error(`no template row ${name}`);
  return li;
}

beforeEach(() => {
  signInAs({ role: "superadmin", store_id: null } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Superadmin rule templates", () => {
  it("lists every template as its rule sentence, hidden ones marked off", async () => {
    setup();
    expect(await screen.findByText("Intermex commission deposit")).toBeInTheDocument();
    const first = rowFor("Intermex commission deposit");
    expect(within(first).getByText("“INTERMEX COMM”")).toBeInTheDocument();
    expect(within(first).getByText("Money transfer commission in bank")).toBeInTheDocument();
    expect(within(first).queryByText("off")).not.toBeInTheDocument();
    expect(within(rowFor("Wire fee")).getByText("off")).toBeInTheDocument();
  });

  it("shows an empty state with no templates", async () => {
    setup({ [LIST]: { body: { rows: [], total: 0 } } });
    expect(await screen.findByText("No templates yet")).toBeInTheDocument();
  });

  it("offers a retry when the list fails to load", async () => {
    let n = 0;
    setup({
      [LIST]: () => (++n === 1
        ? { status: 500, body: { detail: "boom" } }
        : { body: { rows: [commission], total: 1 } }),
    });
    expect(await screen.findByText("Could not load rule templates.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Intermex commission deposit")).toBeInTheDocument();
  });

  it("creates a template from the form without an account", async () => {
    const calls = setup({
      "POST /api/v2/superadmin/bank-rule-templates": { status: 201, body: { template: commission } },
    });
    await screen.findByText("Intermex commission deposit");
    await userEvent.click(screen.getByRole("button", { name: "+ New template" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Account")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Rule name (optional)")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Description match text"), "REMOTE DEPOSIT FEE");
    await waitFor(() => expect(
      within(dialog).getByRole("option", { name: "Other taxes" }),
    ).toBeInTheDocument());
    await userEvent.selectOptions(within(dialog).getByLabelText("Categorize as"), "pl_other_taxes");
    await userEvent.type(within(dialog).getByLabelText("Template name"), "Remote deposit fee");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create template" }));

    expect(await screen.findByText("Template created.")).toBeInTheDocument();
    const posted = callsTo(calls, "POST /api/v2/superadmin/bank-rule-templates");
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({
      name: "Remote deposit fee", desc_match_value: "REMOTE DEPOSIT FEE",
      target_kind: "pl_other_taxes", enabled: true,
    });
    expect(posted[0].body).not.toHaveProperty("account_filter_id");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("edits a template prefilled, and can hide it from stores", async () => {
    const calls = setup({
      "PUT /api/v2/superadmin/bank-rule-templates/9": {
        body: { template: { ...commission, enabled: false } },
      },
    });
    await screen.findByText("Intermex commission deposit");
    await userEvent.click(within(rowFor("Intermex commission deposit")).getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit template")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Template name")).toHaveValue("Intermex commission deposit");
    expect(within(dialog).getByLabelText("Description match text")).toHaveValue("INTERMEX COMM");
    await userEvent.click(within(dialog).getByLabelText("Show to stores"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save template" }));

    expect(await screen.findByText("Template saved.")).toBeInTheDocument();
    const put = callsTo(calls, "PUT /api/v2/superadmin/bank-rule-templates/9");
    expect(put[0].body).toMatchObject({ name: "Intermex commission deposit", enabled: false });
  });

  it("shows a refusal on its field and keeps the form open", async () => {
    setup({
      "POST /api/v2/superadmin/bank-rule-templates": {
        status: 422,
        body: { detail: { field: "target_kind", message: "Pick a category every store has." } },
      },
    });
    await screen.findByText("Intermex commission deposit");
    await userEvent.click(screen.getByRole("button", { name: "+ New template" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Description match text"), "X");
    await waitFor(() => expect(
      within(dialog).getByRole("option", { name: "Other taxes" }),
    ).toBeInTheDocument());
    await userEvent.selectOptions(within(dialog).getByLabelText("Categorize as"), "pl_other_taxes");
    await userEvent.type(within(dialog).getByLabelText("Template name"), "X");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create template" }));
    expect(await within(dialog).findByText("Pick a category every store has.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("asks before deleting, then deletes", async () => {
    const calls = setup({
      "DELETE /api/v2/superadmin/bank-rule-templates/9": { status: 204 },
    });
    await screen.findByText("Intermex commission deposit");
    await userEvent.click(within(rowFor("Intermex commission deposit")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("rules they already made from it stay as they are");
    expect(callsTo(calls, "DELETE /api/v2/superadmin/bank-rule-templates/9")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Template deleted.")).toBeInTheDocument();
    expect(callsTo(calls, "DELETE /api/v2/superadmin/bank-rule-templates/9")).toHaveLength(1);
  });

  it("reports a failed delete and keeps the prompt open", async () => {
    setup({
      "DELETE /api/v2/superadmin/bank-rule-templates/9": { status: 500, body: { detail: "Database down" } },
    });
    await screen.findByText("Intermex commission deposit");
    await userEvent.click(within(rowFor("Intermex commission deposit")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Database down|Could not delete template/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

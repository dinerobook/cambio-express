import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminSubscription from "./AdminSubscription";
import { ApiError } from "../lib/api";

// Cancel subscription asks first, then hands off to Stripe. When the
// hand-off fails the reason shows INSIDE the dialog: while it is open
// the page behind is covered, so an alert there is never seen.

const fetchSubscriptionSummary = vi.fn();
const openBillingPortal = vi.fn();

vi.mock("../api/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/billing")>();
  return {
    ...real,
    fetchSubscriptionSummary: () => fetchSubscriptionSummary(),
    openBillingPortal: () => openBillingPortal(),
  };
});

const PAID = {
  store: { plan: "pro", name: "Cambio", billing_cycle: "monthly" },
  has_paid_plan: true,
  plan_label: "Pro",
  plan_price: "$45 / month",
  cancel_at_period_end: false,
  cancel_at: null,
  addons: [],
  retention_days_left: null,
  referral_code: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminSubscription />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchSubscriptionSummary.mockReset().mockResolvedValue(PAID);
  openBillingPortal.mockReset();
});

describe("AdminSubscription cancel", () => {
  it("shows a failed hand-off to Stripe inside the dialog", async () => {
    openBillingPortal.mockRejectedValue(new ApiError(502, "Stripe is unreachable.", null));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue to Cancel" }));
    expect(await within(dialog).findByText("Stripe is unreachable.")).toBeInTheDocument();
    // ...and the dialog's text is valid markup (no block inside a <p>).
    expect(dialog.querySelector("p p, p div")).toBeNull();
  });
});

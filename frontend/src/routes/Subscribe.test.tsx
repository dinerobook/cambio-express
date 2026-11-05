import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Subscribe from "./Subscribe";
import type { SubscriptionSummary } from "../api/billing";
import { setLanguage } from "../i18n";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { englishLeftovers } from "../test/i18n";
import { renderRoute } from "../test/renderRoute";

// The plan picker. Its prices come from the server's plan catalog
// (/billing/pricing) and the tile marked "Current plan" from the
// summary's `plan_key`. `store.plan` alone is only the tier ("pro"
// for both cadences), which used to mark a YEARLY store's monthly
// tile as its plan and offer it a "switch" to the plan it was on.

const PLANS = [
  { key: "basic", label: "Basic", monthly_cents: 3500, yearly_cents: 35000, months_free: 2 },
  { key: "pro", label: "Pro", monthly_cents: 4500, yearly_cents: 45000, months_free: 2 },
];

function summary(over: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
  return {
    store: {
      id: 1, name: "Cambio Uno", email: "a@b.co", plan: "pro",
      stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
      data_retention_until: null,
    },
    plan_label: "Pro",
    plan_price: "$45 / month",
    plan_key: "pro",
    comped: false,
    has_paid_plan: true,
    trial_status: null,
    trial_days_left: null,
    retention_days_left: null,
    retention_total_days: 180,
    addons: [],
    active_addon_count: 0,
    cancel_at_period_end: false,
    cancel_at: null,
    cancel_at_iso: null,
    referral_code: null,
    ...over,
  };
}

const TRIAL = summary({
  store: { ...summary().store, plan: "trial", stripe_subscription_id: "" },
  plan_label: "Free Trial", plan_price: "", plan_key: "trial",
  has_paid_plan: false, trial_status: "active", trial_days_left: 5,
});
const PRO_MONTHLY = summary();
const PRO_YEARLY = summary({
  plan_label: "Pro (yearly)", plan_price: "$450 / year", plan_key: "pro_yearly",
});

function mount(
  sum: MockHandler,
  extra: Record<string, MockHandler> = {},
  pricing: MockHandler = { body: { plans: PLANS } },
) {
  const calls = mockFetch({
    "GET /api/v2/admin/subscription": sum,
    "GET /api/v2/billing/pricing": pricing,
    ...extra,
  });
  renderRoute(<Subscribe />, { path: "/subscribe" });
  return calls;
}

/** The card whose heading is exactly `name`. */
async function tile(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { level: 2, name });
  return heading.closest("[class*='_tile_']") as HTMLElement;
}

const assign = vi.fn();
const realLocation = window.location;

beforeEach(() => {
  assign.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true, value: realLocation,
  });
  vi.unstubAllGlobals();
});

describe("Subscribe — store not on a paid plan", () => {
  it("offers the four plans with the catalog's names, prices and periods", async () => {
    mount({ body: TRIAL });
    const basicYearly = await tile("Basic (yearly)");
    expect(within(basicYearly).getByText("$350")).toBeInTheDocument();
    expect(within(basicYearly).getByText("/ year")).toBeInTheDocument();
    expect(within(basicYearly).getByText("Same as Basic, 2 months free.")).toBeInTheDocument();
    const proYearly = await tile("Pro (yearly)");
    expect(within(proYearly).getByText("$450")).toBeInTheDocument();
    expect(within(proYearly).getByText("/ year")).toBeInTheDocument();
    const basic = await tile("Basic");
    expect(within(basic).getByText("$35")).toBeInTheDocument();
    expect(within(basic).getByText("/ month")).toBeInTheDocument();
    const pro = await tile("Pro");
    expect(within(pro).getByText("$45")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(4);
    expect(screen.queryByText("Current plan")).not.toBeInTheDocument();
    expect(screen.getByText(/Yearly billing saves 2 months\./)).toBeInTheDocument();
  });

  it("shows the server's prices, not a copy kept in the page", async () => {
    mount({ body: TRIAL }, {}, { body: { plans: [
      { key: "basic", label: "Basic", monthly_cents: 3999, yearly_cents: 39990, months_free: 2 },
      { key: "pro", label: "Pro", monthly_cents: 5000, yearly_cents: 55000, months_free: 1 },
    ] } });
    expect(within(await tile("Basic")).getByText("$39.99")).toBeInTheDocument();
    expect(within(await tile("Pro (yearly)")).getByText("$550")).toBeInTheDocument();
    expect(screen.getByText("Same as Pro, 1 month free.")).toBeInTheDocument();
    // The header claims only what every plan saves.
    expect(screen.getByText(/Yearly billing saves 1 month\./)).toBeInTheDocument();
  });

  it("sends a yearly pick to Stripe Checkout with its yearly key", async () => {
    const calls = mount({ body: TRIAL }, {
      "POST /api/v2/billing/checkout": { body: { url: "https://checkout.stripe.test/c" } },
    });
    const card = await tile("Basic (yearly)");
    fireEvent.click(within(card).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c"));
    expect(callsTo(calls, "POST /api/v2/billing/checkout")[0].body).toEqual({ plan: "basic_yearly" });
    expect(callsTo(calls, "POST /api/v2/billing/portal")).toHaveLength(0);
  });

  it("shows checkout's refusal and lets the person try again", async () => {
    mount({ body: TRIAL }, {
      "POST /api/v2/billing/checkout": { status: 422, body: { detail: "Invalid plan selected." } },
    });
    const card = await tile("Pro (yearly)");
    fireEvent.click(within(card).getByRole("button", { name: "Subscribe" }));
    expect(await screen.findByText("Invalid plan selected.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    for (const b of screen.getAllByRole("button", { name: "Subscribe" })) expect(b).toBeEnabled();
  });

  it("still offers every plan when the summary fails, and asks for it once", async () => {
    const calls = mount({ status: 500, body: { detail: "down" } });
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 100));
    expect(callsTo(calls, "GET /api/v2/admin/subscription")).toHaveLength(1);
  });

  it("shows an error with retry when the plans can't load", async () => {
    let fail = true;
    mount({ body: TRIAL }, {}, () => (fail
      ? { status: 500, body: { detail: "down" } }
      : { body: { plans: PLANS } }));
    expect(await screen.findByText("Could not load the plans.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Subscribe" })).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Subscribe" })).toHaveLength(4));
  });

  it("asks a signed-out visitor to sign in first", async () => {
    window.localStorage.removeItem("db.identity");
    const calls = mount({ body: TRIAL });
    expect(await screen.findByText("Sign in first to choose a plan.")).toBeInTheDocument();
    expect(callsTo(calls, "GET /api/v2/admin/subscription")).toHaveLength(0);
  });
});

describe("Subscribe — store with a subscription", () => {
  it("marks Pro monthly as current and names its price", async () => {
    mount({ body: PRO_MONTHLY });
    const pro = await tile("Pro");
    expect(within(pro).getByText("Current plan", { selector: "span" })).toBeInTheDocument();
    expect(within(pro).getByRole("button", { name: "Current plan" })).toBeDisabled();
    const proYearly = await tile("Pro (yearly)");
    expect(within(proYearly).getByRole("button", { name: "Switch to Pro (yearly)" })).toBeEnabled();
    expect(screen.getByText(/You're currently on Pro \(\$45 \/ month\)\./)).toBeInTheDocument();
  });

  it("marks Pro YEARLY as current for a yearly store, not the monthly tile", async () => {
    mount({ body: PRO_YEARLY });
    const proYearly = await tile("Pro (yearly)");
    expect(within(proYearly).getByRole("button", { name: "Current plan" })).toBeDisabled();
    const pro = await tile("Pro");
    expect(within(pro).queryByText("Current plan")).not.toBeInTheDocument();
    expect(within(pro).getByRole("button", { name: "Switch to Pro" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Switch to Pro (yearly)" })).not.toBeInTheDocument();
    expect(screen.getByText(/You're currently on Pro \(yearly\) \(\$450 \/ year\)\./)).toBeInTheDocument();
    expect(screen.queryByText(/\$45 \/ month/)).not.toBeInTheDocument();
  });

  it("marks Basic yearly as current for a Basic yearly store", async () => {
    mount({ body: summary({
      store: { ...summary().store, plan: "basic" },
      plan_label: "Basic (yearly)", plan_price: "$350 / year", plan_key: "basic_yearly",
    }) });
    const card = await tile("Basic (yearly)");
    expect(within(card).getByRole("button", { name: "Current plan" })).toBeDisabled();
    expect(screen.getByText(/You're currently on Basic \(yearly\) \(\$350 \/ year\)\./)).toBeInTheDocument();
  });

  it("opens the billing portal to switch, never a second checkout", async () => {
    const calls = mount({ body: PRO_YEARLY }, {
      "POST /api/v2/billing/portal": { body: { url: "https://billing.stripe.test/p" } },
    });
    const pro = await tile("Pro");
    fireEvent.click(within(pro).getByRole("button", { name: "Switch to Pro" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.stripe.test/p"));
    expect(callsTo(calls, "POST /api/v2/billing/checkout")).toHaveLength(0);
  });

  it("shows the portal's refusal", async () => {
    mount({ body: PRO_MONTHLY }, {
      "POST /api/v2/billing/portal": { status: 502, body: { detail: "Payment service error. Please try again." } },
    });
    const basic = await tile("Basic");
    fireEvent.click(within(basic).getByRole("button", { name: "Switch to Basic" }));
    expect(await screen.findByText("Payment service error. Please try again.")).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("flags a cancelled yearly plan on its own tile, with the end date", async () => {
    mount({ body: summary({
      ...PRO_YEARLY, cancel_at_period_end: true,
      cancel_at: "December 05, 2026", cancel_at_iso: "2026-12-05T18:00:00",
    }) });
    const proYearly = await tile("Pro (yearly)");
    expect(within(proYearly).getByText("Cancelled")).toBeInTheDocument();
    expect(within(proYearly).getByRole("button", { name: "Resubscribe" })).toBeEnabled();
    expect(within(await tile("Pro")).queryByText("Cancelled")).not.toBeInTheDocument();
    expect(screen.getByText(
      "Your Pro (yearly) subscription is cancelled and stays active until Dec 5, 2026. "
      + "To keep your access, resubscribe below before it expires.",
    )).toBeInTheDocument();
  });

  it("says a comped store pays nothing instead of quoting its tier's price", async () => {
    mount({ body: summary({ comped: true, plan_price: "" }) });
    expect(await screen.findByText(/You're currently on Pro, at no charge\./)).toBeInTheDocument();
    expect(screen.queryByText(/\$45 \/ month/)).not.toBeInTheDocument();
  });

  it("names a plan the catalog no longer sells by the server's label", async () => {
    mount({ body: summary({ plan_key: "legacy", plan_label: "Legacy" }) });
    expect(await screen.findByText(/You're currently on Legacy\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Current plan" })).not.toBeInTheDocument();
  });
});

describe("Subscribe — Spanish", () => {
  it("shows the page in Spanish with no English left", async () => {
    setLanguage("es");
    mount({ body: PRO_YEARLY });
    const proYearly = await tile("Pro (anual)");
    expect(within(proYearly).getByText("/ año")).toBeInTheDocument();
    expect(within(proYearly).getByRole("button", { name: "Plan actual" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cambiar a Pro" })).toBeEnabled();
    expect(screen.getByText(/Su plan actual es Pro \(anual\) \(\$450 \/ año\)\./)).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["subscribe."])).toEqual([]);
  });

  it("words the cancel date and a server refusal in Spanish", async () => {
    setLanguage("es");
    mount({ body: summary({
      ...PRO_YEARLY, cancel_at_period_end: true,
      cancel_at: "December 05, 2026", cancel_at_iso: "2026-12-05T18:00:00",
    }) }, {
      "POST /api/v2/billing/portal": { status: 409, body: {
        detail: "No billing account on file. Subscribe to a plan first.",
      } },
    });
    expect(await screen.findByText(/sigue activa hasta el 5 dic 2026/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Volver a suscribirse" }));
    expect(await screen.findByText(
      "No hay una cuenta de facturación registrada. Primero suscríbase a un plan.",
    )).toBeInTheDocument();
    expect(englishLeftovers(document.body, ["subscribe."])).toEqual([]);
  });
});

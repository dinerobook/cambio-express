import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminReferrals from "./AdminReferrals";
import type { ReferralCodeResponse, ReferralRedemptionRow } from "../api/admin";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// Settings → Referrals: the store's code, its credits, and the
// redemption history on the kit <DataTable>. A trial store sees the
// upsell (409), an employee is turned away.

let state: {
  data?: ReferralCodeResponse; isLoading: boolean; isError: boolean; error?: unknown;
};
const refetch = vi.fn();

vi.mock("../api/admin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/admin")>();
  return { ...real, useReferralCode: () => ({ ...state, refetch }) };
});

function redemption(over: Partial<ReferralRedemptionRow> = {}): ReferralRedemptionRow {
  return {
    redeemed_at: "2026-10-20T15:00:00",
    referee_store_id: 42,
    self_credit_applied: true,
    referee_credit_applied: false,
    stripe_self_txn_id: "cbtxn_123",
    ...over,
  };
}

function code(redemptions: ReferralRedemptionRow[]): ReferralCodeResponse {
  return {
    code: "SHOP-ABCD",
    share_url: "https://dinerobook.com/signup?ref=SHOP-ABCD",
    reward_self_cents: 2500,
    reward_referee_cents: 2500,
    redeemed_count: redemptions.length,
    credits_earned_cents: 2500,
    is_active: true,
    redemptions,
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <AdminReferrals />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("AdminReferrals", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN });
    state = { data: code([redemption()]), isLoading: false, isError: false };
  });

  it("lists redemptions on the shared table with each side's credit", () => {
    renderPage();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent))
      .toEqual(["Date", "Referred store", "Your credit", "Their credit"]);
    const row = screen.getByText("#42").closest("tr")!;
    expect(within(row).getByText("Credited")).toBeInTheDocument();
    expect(within(row).getByText("cbtxn_123")).toBeInTheDocument();
    expect(within(row).getByText("Pending")).toBeInTheDocument();
  });

  it("says so when nobody has redeemed yet", () => {
    state = { data: code([]), isLoading: false, isError: false };
    renderPage();
    expect(screen.getByText(/No referrals yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers plans to a trial store (409)", () => {
    state = { isLoading: false, isError: true, error: new ApiError(409, "Paid plan only", null) };
    renderPage();
    expect(screen.getByText("Unlock referrals on a paid plan")).toBeInTheDocument();
  });

  it("turns an employee away", () => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "employee" });
    renderPage();
    expect(screen.getByText(/store-admin sign-in/)).toBeInTheDocument();
  });
});

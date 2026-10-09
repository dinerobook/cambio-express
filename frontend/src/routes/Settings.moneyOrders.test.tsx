import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SettingsGeneral } from "./Settings";
import { ToastProvider } from "../components/ui/Toast";
import type { MTCompanyEntry } from "../api/account";

// Settings → Money transfer companies → "Money orders": not every
// provider sells money orders, so each company has its own switch.
// Only companies with it on are listed on the daily book's Money
// orders tab. Every company starts with it on; a company that is
// switched off entirely can't have it changed; someone who may only
// read settings can't change it either.

const useStoreInfo = vi.fn();
const updateStoreInfo = vi.fn();

vi.mock("../api/account", () => ({
  useStoreInfo: () => useStoreInfo(),
  updateStoreInfo: (...a: unknown[]) => updateStoreInfo(...a),
}));
vi.mock("../api/owner", () => ({ redeemConnectCode: vi.fn() }));

function store(mt_companies: Array<Partial<MTCompanyEntry> & { name: string }>) {
  return {
    data: {
      referral_code: null,
      store: {
        id: 7, name: "Store", slug: "s", email: "", phone: "", address: "",
        plan: "basic", federal_tax_rate: 0, sales_tax_rate: 0,
        is_active: true, receipt_logo_url: "", receipt_footer: "",
        receipt_tax_id: "", timezone: "America/Chicago",
        timezone_choices: ["America/Chicago"],
        store_hours: [], enforce_business_hours: false,
        timeclock_require_passkey: false, timeclock_geofence_lat: null,
        timeclock_geofence_lng: null, timeclock_geofence_radius_m: 0,
        timeclock_require_geofence: false,
        timeclock_late_minutes_threshold: 5,
        legal_name: "", ein: "", business_address: "", mt_companies,
      },
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  };
}

function signIn(permissions: string[]) {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "u", full_name: "U", role: "admin", store_id: 7,
    permissions,
  }));
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><SettingsGeneral /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const moSwitch = (company: string) =>
  screen.getByRole("switch", { name: `${company} sells money orders` });

beforeEach(() => {
  signIn(["settings.read", "settings.update"]);
  updateStoreInfo.mockReset().mockResolvedValue({});
});

describe("Settings → money orders per company", () => {
  it("shows each company's switch as saved", () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
      { name: "Maxi", enabled: true, money_orders: false },
    ]));
    renderTab();
    expect(moSwitch("Intermex")).toBeChecked();
    expect(moSwitch("Maxi")).not.toBeChecked();
  });

  it("treats a company saved before the switch existed as on", () => {
    useStoreInfo.mockReturnValue(store([{ name: "Barri", enabled: true }]));
    renderTab();
    expect(moSwitch("Barri")).toBeChecked();
  });

  it("saves a company switched off for money orders", async () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
      { name: "Barri", enabled: true, money_orders: true },
    ]));
    renderTab();
    await userEvent.click(moSwitch("Barri"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateStoreInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        mt_companies: [
          { name: "Intermex", enabled: true, money_orders: true },
          { name: "Barri", enabled: true, money_orders: false },
        ],
      }),
    ));
  });

  it("starts a newly added company with money orders on", async () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
    ]));
    renderTab();
    await userEvent.type(screen.getByPlaceholderText(/Add a company/), "Ria");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(moSwitch("Ria")).toBeChecked();
  });

  it("locks the switch for a company that is hidden", () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
      { name: "Maxi", enabled: false, money_orders: true },
    ]));
    renderTab();
    expect(moSwitch("Intermex")).toBeEnabled();
    expect(moSwitch("Maxi")).toBeDisabled();
  });

  it("can't be changed by someone who may only read settings", () => {
    signIn(["settings.read"]);
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
    ]));
    renderTab();
    expect(moSwitch("Intermex")).toBeDisabled();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import SettingsMoneyServices from "./SettingsMoneyServices";
import { ToastProvider } from "../components/ui/Toast";
import type { MTCompanyEntry } from "../api/account";

// Settings → Money services → "Money orders": not every provider
// sells money orders, so each company has its own switch. Only
// companies with it on are listed on the daily book's Money orders
// tab. Every company starts with it on; a company that is switched
// off entirely can't have it changed; someone who may only read
// settings can't change it either. A company that sells money orders
// also takes what it charges per money order (owner, 2026-10-20) —
// the Monthly P&L takes count × charge off the money order fees — and
// the box is not shown for a company that does not sell them.

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
        <MemoryRouter><SettingsMoneyServices /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const moSwitch = (company: string) =>
  screen.getByRole("switch", { name: `${company} sells money orders` });
const chargeBox = (company: string) =>
  screen.queryByRole("textbox", { name: `${company} charge per money order` });

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
          { name: "Intermex", enabled: true, money_orders: true, money_order_charge: 0 },
          { name: "Barri", enabled: true, money_orders: false, money_order_charge: 0 },
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
    await userEvent.click(screen.getByRole("button", { name: "Add company" }));
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

  it("shows the charge per money order only for companies that sell them", () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true, money_order_charge: 0.3 },
      { name: "Maxi", enabled: true, money_orders: false },
      { name: "Barri", enabled: false, money_orders: true },
    ]));
    renderTab();
    expect(chargeBox("Intermex")).toHaveValue("0.3");
    expect(chargeBox("Maxi")).not.toBeInTheDocument();
    expect(chargeBox("Barri")).not.toBeInTheDocument();
  });

  it("saves a company's charge per money order", async () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
    ]));
    renderTab();
    await userEvent.type(chargeBox("Intermex")!, "0.30");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateStoreInfo).toHaveBeenCalledWith({
      mt_companies: [
        { name: "Intermex", enabled: true, money_orders: true, money_order_charge: 0.3 },
      ],
      transfer_countries: [],
    }));
  });

  it("hides the charge box when money orders are switched off", async () => {
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true },
    ]));
    renderTab();
    expect(chargeBox("Intermex")).toBeInTheDocument();
    await userEvent.click(moSwitch("Intermex"));
    expect(chargeBox("Intermex")).not.toBeInTheDocument();
  });

  it("locks the charge for someone who may only read settings", () => {
    signIn(["settings.read"]);
    useStoreInfo.mockReturnValue(store([
      { name: "Intermex", enabled: true, money_orders: true, money_order_charge: 0.3 },
    ]));
    renderTab();
    expect(chargeBox("Intermex")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});

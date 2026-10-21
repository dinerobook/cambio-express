import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import SettingsMoneyServices from "./SettingsMoneyServices";
import { ToastProvider } from "../components/ui/Toast";

// Settings → Money services → Transfer countries: the store admin's own list
// for the transfer form's country picker (owner ask 2026-10-13). Starts
// as the list the form always had; add, remove, refuse a duplicate or
// a comma, save with the tab, and tell the transfer + batch forms to
// reload their lists. Someone who may only read settings can't change
// it.

const useStoreInfo = vi.fn();
const updateStoreInfo = vi.fn();

vi.mock("../api/account", () => ({
  useStoreInfo: () => useStoreInfo(),
  updateStoreInfo: (...a: unknown[]) => updateStoreInfo(...a),
}));
vi.mock("../api/owner", () => ({ redeemConnectCode: vi.fn() }));

function store(transfer_countries: string[]) {
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
        legal_name: "", ein: "", business_address: "",
        mt_companies: [{ name: "Intermex", enabled: true, money_orders: true }],
        transfer_countries,
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

let qc: QueryClient;
function renderTab() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><SettingsMoneyServices /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const newCountry = () => screen.getByRole("textbox", { name: "New country" });
const addCountry = () => screen.getByRole("button", { name: "Add country" });
const save = () => screen.getByRole("button", { name: "Save" });

beforeEach(() => {
  signIn(["settings.read", "settings.update"]);
  updateStoreInfo.mockReset().mockResolvedValue({});
});

describe("Settings → Transfer countries", () => {
  it("lists the store's countries in order", () => {
    useStoreInfo.mockReturnValue(store(["Mexico", "Guatemala"]));
    renderTab();
    expect(screen.getByText("Transfer countries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Mexico" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Guatemala" })).toBeInTheDocument();
  });

  it("adds and removes countries and saves the list", async () => {
    useStoreInfo.mockReturnValue(store(["Mexico", "Guatemala"]));
    renderTab();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await userEvent.type(newCountry(), "Cuba{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Remove Guatemala" }));
    await userEvent.click(save());
    await waitFor(() => expect(updateStoreInfo).toHaveBeenCalledWith(
      expect.objectContaining({ transfer_countries: ["Mexico", "Cuba"] }),
    ));
    // The transfer and batch forms reload the store's lists.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith(
      { queryKey: ["transfers", "choices"] },
    ));
  });

  it("refuses a country already on the list, in any case", async () => {
    useStoreInfo.mockReturnValue(store(["Mexico"]));
    renderTab();
    await userEvent.type(newCountry(), "mexico");
    await userEvent.click(addCountry());
    expect(await screen.findByText("mexico is already on the list.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove mexico" })).not.toBeInTheDocument();
  });

  it("refuses a comma", async () => {
    useStoreInfo.mockReturnValue(store(["Mexico"]));
    renderTab();
    await userEvent.type(newCountry(), "Korea, South");
    await userEvent.click(addCountry());
    expect(await screen.findByText("Country names can’t contain commas.")).toBeInTheDocument();
  });

  it("keeps at least one country", () => {
    useStoreInfo.mockReturnValue(store(["Mexico"]));
    renderTab();
    expect(screen.getByRole("button", { name: "Remove Mexico" })).toBeDisabled();
  });

  it("is not an unsaved change until something is edited", async () => {
    useStoreInfo.mockReturnValue(store(["Mexico", "Peru"]));
    renderTab();
    expect(save()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove Peru" }));
    expect(save()).toBeEnabled();
  });

  it("shows the server's refusal", async () => {
    const { ApiError } = await import("../lib/api");
    updateStoreInfo.mockRejectedValue(new ApiError(422, "Duplicate country 'Peru'.", null));
    useStoreInfo.mockReturnValue(store(["Mexico"]));
    renderTab();
    await userEvent.type(newCountry(), "Peru{Enter}");
    await userEvent.click(save());
    expect(await screen.findByText("Duplicate country 'Peru'.")).toBeInTheDocument();
  });

  it("can't be changed by someone who may only read settings", () => {
    signIn(["settings.read"]);
    useStoreInfo.mockReturnValue(store(["Mexico", "Peru"]));
    renderTab();
    expect(screen.getByRole("button", { name: "Remove Peru" })).toBeDisabled();
    expect(newCountry()).toBeDisabled();
    expect(addCountry()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("the company add row refuses a duplicate too", async () => {
    useStoreInfo.mockReturnValue(store(["Mexico"]));
    renderTab();
    const row = screen.getByRole("textbox", { name: "New company" });
    await userEvent.type(row, "INTERMEX");
    await userEvent.click(screen.getByRole("button", { name: "Add company" }));
    expect(await screen.findByText("INTERMEX is already on the list.")).toBeInTheDocument();
  });
});

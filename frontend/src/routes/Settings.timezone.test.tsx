import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SettingsGeneral } from "./Settings";
import { ToastProvider } from "../components/ui/Toast";

// The store's timezone (General tab) is the clock every date and
// time in the app reads. With none saved, each device shows its own
// time, so the tab says so; saving refreshes session-status, which
// is where the shell reads the zone from.

const useStoreInfo = vi.fn();
const updateStoreInfo = vi.fn();

vi.mock("../api/account", () => ({
  useStoreInfo: () => useStoreInfo(),
  updateStoreInfo: (...a: unknown[]) => updateStoreInfo(...a),
}));
vi.mock("../api/owner", () => ({ redeemConnectCode: vi.fn() }));

function store(timezone: string) {
  return {
    data: {
      referral_code: null,
      store: {
        id: 7, name: "Store", slug: "s", email: "", phone: "", address: "",
        plan: "basic", federal_tax_rate: 0, sales_tax_rate: 0,
        is_active: true, receipt_logo_url: "", receipt_footer: "",
        receipt_tax_id: "", timezone,
        timezone_choices: ["America/Chicago", "America/New_York"],
        store_hours: [], enforce_business_hours: false,
        timeclock_require_passkey: false, timeclock_geofence_lat: null,
        timeclock_geofence_lng: null, timeclock_geofence_radius_m: 0,
        timeclock_require_geofence: false,
        timeclock_late_minutes_threshold: 5,
        legal_name: "", ein: "", business_address: "", mt_companies: [],
      },
    },
    isLoading: false, isError: false, refetch: vi.fn(),
  };
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><SettingsGeneral /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { invalidate };
}

const HINT = /No timezone saved yet/;

beforeEach(() => {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "u", full_name: "U", role: "admin", store_id: 7,
    permissions: ["settings.read", "settings.update"],
  }));
  updateStoreInfo.mockReset().mockResolvedValue({});
});

describe("Settings → General timezone", () => {
  it("says times follow each device until a timezone is saved", () => {
    useStoreInfo.mockReturnValue(store(""));
    renderTab();
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("drops the reminder once the store has a timezone", () => {
    useStoreInfo.mockReturnValue(store("America/Chicago"));
    renderTab();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("saving refreshes the zone the whole app renders in", async () => {
    useStoreInfo.mockReturnValue(store(""));
    const { invalidate } = renderTab();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Timezone/ }), "America/Chicago",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateStoreInfo).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Chicago" }),
    ));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["account", "session-status"],
    }));
  });

  it("does not refresh anything when the save fails", async () => {
    useStoreInfo.mockReturnValue(store(""));
    updateStoreInfo.mockRejectedValue(new Error("boom"));
    const { invalidate } = renderTab();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Timezone/ }), "America/New_York",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateStoreInfo).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: ["account", "session-status"],
    });
  });
});

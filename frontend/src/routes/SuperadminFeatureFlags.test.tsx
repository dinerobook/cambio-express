import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminFeatureFlags from "./SuperadminFeatureFlags";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import type { FeatureFlagRow, StoreOverrideRow } from "../api/featureFlags";

// Feature flags gate whole features per store (CLAUDE.md invariant
// #6). Pinned: the toggle flips the GLOBAL default to its opposite,
// delete goes through a confirm, create sends the trimmed key, and
// the per-store override panel writes for the store typed in.

const createFeatureFlag = vi.fn();
const toggleFeatureFlag = vi.fn();
const deleteFeatureFlag = vi.fn();
const setStoreOverride = vi.fn();
const clearStoreOverride = vi.fn();

let flags: {
  data?: { rows: FeatureFlagRow[]; total: number };
  isLoading: boolean; isError: boolean;
};
let overrides: StoreOverrideRow[] = [];

vi.mock("../api/featureFlags", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/featureFlags")>();
  return {
    ...real,
    useFeatureFlags: () => ({ ...flags, refetch: vi.fn() }),
    useStoreOverrides: () => ({
      data: { rows: overrides, total: overrides.length }, isLoading: false,
    }),
    createFeatureFlag: (...a: unknown[]) => createFeatureFlag(...a),
    toggleFeatureFlag: (...a: unknown[]) => toggleFeatureFlag(...a),
    deleteFeatureFlag: (...a: unknown[]) => deleteFeatureFlag(...a),
    setStoreOverride: (...a: unknown[]) => setStoreOverride(...a),
    clearStoreOverride: (...a: unknown[]) => clearStoreOverride(...a),
  };
});

const flag = (id: number, key: string, on: boolean): FeatureFlagRow => ({
  id, key, label: key.toUpperCase(), description: "",
  enabled_by_default: on, created_at: "2026-01-02T00:00:00",
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SuperadminFeatureFlags />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const rowOf = (key: string) => screen.getByText(key).closest("tr")!;

describe("SuperadminFeatureFlags", () => {
  beforeEach(() => {
    for (const fn of [createFeatureFlag, toggleFeatureFlag, deleteFeatureFlag,
      setStoreOverride, clearStoreOverride]) {
      fn.mockReset();
      fn.mockResolvedValue({});
    }
    flags = {
      data: { rows: [flag(1, "bank_sync", true), flag(2, "addon_tv", false)], total: 2 },
      isLoading: false, isError: false,
    };
    overrides = [];
  });

  it("lists every flag with its global default", () => {
    renderPage();
    expect(within(rowOf("bank_sync")).getByText("ON")).toBeInTheDocument();
    expect(within(rowOf("addon_tv")).getByText("OFF")).toBeInTheDocument();
  });

  it("shows an error when flags fail to load", () => {
    flags = { isLoading: false, isError: true };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load feature flags.");
  });

  it("flips the global default to its opposite", async () => {
    renderPage();
    await userEvent.click(within(rowOf("bank_sync")).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(toggleFeatureFlag).toHaveBeenCalledWith("bank_sync", false));
    expect(await screen.findByText("bank_sync → disabled")).toBeInTheDocument();
  });

  it("toasts a refused toggle", async () => {
    toggleFeatureFlag.mockRejectedValue(new ApiError(403, "Superadmin only.", null));
    renderPage();
    await userEvent.click(within(rowOf("addon_tv")).getByRole("button", { name: "Enable" }));
    expect(await screen.findByText("Superadmin only.")).toBeInTheDocument();
  });

  it("deletes only after the confirm", async () => {
    renderPage();
    await userEvent.click(within(rowOf("addon_tv")).getByRole("button", { name: "Delete" }));
    expect(deleteFeatureFlag).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Delete flag "addon_tv"?');
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteFeatureFlag).toHaveBeenCalledWith("addon_tv"));
  });

  it("creates a flag with trimmed fields", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "+ New flag" }));
    await userEvent.type(screen.getByLabelText(/^Key/), "addon_lottery");
    await userEvent.type(screen.getByLabelText("Label"), "  Lottery  ");
    await userEvent.click(screen.getByRole("checkbox", { name: "Enabled by default" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(createFeatureFlag).toHaveBeenCalledWith({
      key: "addon_lottery", label: "Lottery", description: undefined,
      enabled_by_default: false,
    }));
    expect(await screen.findByText('Flag "addon_lottery" created')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  });

  it("keeps the create form open with the refusal", async () => {
    createFeatureFlag.mockRejectedValue(new ApiError(409, "Flag already exists.", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "+ New flag" }));
    await userEvent.type(screen.getByLabelText(/^Key/), "bank_sync");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Flag already exists.");
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("adds, flips and clears a per-store override", async () => {
    overrides = [{
      store_id: 4, store_slug: "north", store_name: "North", flag_key: "bank_sync",
      enabled: true, updated_at: "2026-01-02T00:00:00",
    }];
    renderPage();
    await userEvent.click(within(rowOf("bank_sync")).getByRole("button", { name: "Overrides" }));
    await userEvent.type(screen.getByPlaceholderText("Store ID"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Add override" }));
    await waitFor(() => expect(setStoreOverride).toHaveBeenCalledWith("bank_sync", 9, true));

    const north = screen.getByText("North").closest("tr")!;
    await userEvent.click(within(north).getByRole("button", { name: "Flip" }));
    await waitFor(() => expect(setStoreOverride).toHaveBeenLastCalledWith("bank_sync", 4, false));
    await userEvent.click(within(north).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(clearStoreOverride).toHaveBeenCalledWith("bank_sync", 4));
  });
});

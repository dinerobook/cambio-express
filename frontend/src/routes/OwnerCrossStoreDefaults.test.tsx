import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerCrossStoreDefaults from "./OwnerCrossStoreDefaults";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { renderRouteWithGuard } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";

// Owner → Cross-store defaults: tick the fields to push, pick stores,
// apply once. It had no tests. Pinned: owner-only, only ticked fields
// are sent (the federal tax as a fraction), per-store results show,
// a refusal is an error, and a ticked-but-not-applied form warns
// before it is left.

const useOwnerLocations = vi.fn();
const applyCrossStoreDefaults = vi.fn();

vi.mock("../api/owner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/owner")>()),
  useOwnerLocations: () => useOwnerLocations(),
  applyCrossStoreDefaults: (...a: unknown[]) => applyCrossStoreDefaults(...a),
}));

const locations = {
  rows: [
    { store_id: 1, store_name: "Downtown", store_slug: "downtown" },
    { store_id: 2, store_name: "Uptown", store_slug: "uptown" },
  ],
};

beforeEach(() => {
  setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
  useOwnerLocations.mockReturnValue({
    data: locations, isLoading: false, isError: false, refetch: vi.fn(),
  });
  applyCrossStoreDefaults.mockReset().mockResolvedValue({
    results: [{ store_id: 1, store_name: "Downtown", status: "updated", detail: "" }],
  });
});

function renderPage() {
  return renderRouteWithGuard(<OwnerCrossStoreDefaults />, { path: "/owner/defaults" });
}

describe("OwnerCrossStoreDefaults", () => {
  it("is owner-only", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText("This page is owner-only.")).toBeInTheDocument();
  });

  it("sends only the ticked fields to the picked stores", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("checkbox", { name: /^Federal tax rate/ }));
    const rate = screen.getByLabelText("Federal tax rate (%)");
    await user.clear(rate);
    await user.type(rate, "2");
    await user.click(screen.getByRole("checkbox", { name: /Downtown/ }));
    await user.click(screen.getByRole("button", { name: "Apply to 1 store" }));
    await waitFor(() => expect(applyCrossStoreDefaults).toHaveBeenCalledWith({
      store_ids: [1], federal_tax_rate: 0.02,
    }));
    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
  });

  it("shows a refusal as an error", async () => {
    applyCrossStoreDefaults.mockRejectedValue(new ApiError(403, "Not your store.", null));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("checkbox", { name: /^Timezone/ }));
    await user.click(screen.getByRole("checkbox", { name: /Downtown/ }));
    await user.click(screen.getByRole("button", { name: "Apply to 1 store" }));
    expect(await screen.findByText("Not your store.")).toBeInTheDocument();
  });

  it("warns before leaving defaults that were not applied; applied ones leave freely", async () => {
    const user = userEvent.setup();
    const { router } = renderPage();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: /^Timezone/ }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    act(() => { void router.navigate("/owner"); });
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/owner/defaults");

    await user.click(screen.getByRole("checkbox", { name: /Downtown/ }));
    await user.click(screen.getByRole("button", { name: "Apply to 1 store" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull());
    act(() => { void router.navigate("/owner"); });
    expect(await screen.findByText("Navigated to /owner")).toBeInTheDocument();
  });
});

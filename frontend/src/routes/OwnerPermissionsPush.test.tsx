import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OwnerBulkPermissions from "./OwnerBulkPermissions";
import OwnerCrossStoreDefaults from "./OwnerCrossStoreDefaults";
import { callsTo, mockFetch, type MockHandler } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";

// The owner's two "push to many stores" pages. Both write to every
// store ticked, so pin that only the ticked stores (and, for the
// defaults, only the ticked fields) travel, that the per-store
// result is shown, and that a refused push is shown.

const row = (on: Partial<Record<string, boolean>> = {}) => ({
  create: false, read: false, update: false, delete: false, ...on,
});
const LOCATIONS = {
  rows: [
    { store_id: 1, store_name: "Uno", store_slug: "uno", transfer_count: 0,
      volume: 0, over_short: 0, report_count: 0, companies: [] },
    { store_id: 2, store_name: "Dos", store_slug: "dos", transfer_count: 0,
      volume: 0, over_short: 0, report_count: 0, companies: [] },
  ],
  total: 2, matched: 2,
};
const STORE1_PERMS = {
  store_id: 1, roles: ["admin", "employee"], editable_roles: ["employee"],
  resources: ["transfers"], actions: ["create", "read", "update", "delete"],
  matrix: {
    admin: { transfers: row({ create: true, read: true, update: true, delete: true }) },
    employee: { transfers: row({ read: true }) },
  },
  has_overrides: [],
};

function routes(extra: Record<string, MockHandler> = {}) {
  return {
    "GET /api/v2/owner/locations": { body: LOCATIONS },
    "GET /api/v2/owner/store/1/permissions": { body: STORE1_PERMS },
    ...extra,
  };
}

beforeEach(() => { signInAs({ role: "owner", store_id: null }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Owner bulk permissions", () => {
  async function pickSourceAndTarget() {
    await userEvent.click(await screen.findByRole("button", { name: "Uno" }));
    expect(await screen.findByLabelText("View — Money transfers (employee)")).toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Dos" }));
  }

  it("keeps Push disabled until a source and a target are chosen", async () => {
    mockFetch(routes());
    renderRoute(<OwnerBulkPermissions />);
    expect(await screen.findByRole("button", { name: "Push to 0 stores" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Dos" }));
    expect(screen.getByRole("button", { name: "Push to 1 store" })).toBeDisabled();
  });

  it("pushes only the editable (employee) row to the ticked stores", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/owner/bulk-permissions": {
        body: { results: [{ store_id: 2, status: "applied", changes: 3 }] },
      },
    }));
    renderRoute(<OwnerBulkPermissions />);
    await pickSourceAndTarget();
    await userEvent.click(screen.getByRole("button", { name: "Push to 1 store" }));
    expect(await screen.findByText("Pushed permissions to 1 store(s).")).toBeInTheDocument();
    expect(screen.getByText("Applied")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/owner/bulk-permissions")[0].body).toEqual({
      store_ids: [2], matrix: { employee: { transfers: row({ read: true }) } },
    });
  });

  it("shows a store the server rejected", async () => {
    mockFetch(routes({
      "POST /api/v2/owner/bulk-permissions": {
        body: { results: [{ store_id: 2, status: "rejected", reason: "Not your store" }] },
      },
    }));
    renderRoute(<OwnerBulkPermissions />);
    await pickSourceAndTarget();
    await userEvent.click(screen.getByRole("button", { name: "Push to 1 store" }));
    expect(await screen.findByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("Not your store")).toBeInTheDocument();
    expect(await screen.findByText("Pushed permissions to 0 store(s).")).toBeInTheDocument();
  });

  it("shows the refusal when the whole push is forbidden", async () => {
    mockFetch(routes({
      "POST /api/v2/owner/bulk-permissions": { status: 403, body: { detail: "Owner only." } },
    }));
    renderRoute(<OwnerBulkPermissions />);
    await pickSourceAndTarget();
    await userEvent.click(screen.getByRole("button", { name: "Push to 1 store" }));
    expect(await screen.findByText("Owner only.")).toBeInTheDocument();
  });

  it("offers a retry when the stores fail to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/owner/locations": () => (fail ? { status: 500, body: {} } : { body: LOCATIONS }),
    }));
    renderRoute(<OwnerBulkPermissions />);
    expect(await screen.findByText("Couldn't load your stores.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Uno" })).toBeInTheDocument();
  });

  it("offers a retry when the source store's permissions fail to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/owner/store/1/permissions": () => (
        fail ? { status: 500, body: {} } : { body: STORE1_PERMS }),
    }));
    renderRoute(<OwnerBulkPermissions />);
    await userEvent.click(await screen.findByRole("button", { name: "Uno" }));
    expect(await screen.findByText("Couldn't load this store's permissions.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("View — Money transfers (employee)")).toBeChecked();
  });
});

describe("Owner cross-store defaults", () => {
  it("refuses a store admin", () => {
    signInAs({ role: "admin" });
    mockFetch(routes());
    renderRoute(<OwnerCrossStoreDefaults />);
    expect(screen.getByText("This page is owner-only.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply to/ })).not.toBeInTheDocument();
  });

  it("needs a field and a store before it can apply", async () => {
    mockFetch(routes());
    renderRoute(<OwnerCrossStoreDefaults />);
    await screen.findByText("uno");
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Apply to 2 stores" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /^Phone/ }));
    expect(screen.getByRole("button", { name: "Apply to 2 stores" })).toBeEnabled();
  });

  it("sends only the ticked fields, the tax rate as a decimal", async () => {
    const calls = mockFetch(routes({
      "POST /api/v2/owner/cross-store-defaults": {
        body: { results: [
          { store_id: 1, store_name: "Uno", status: "updated" },
          { store_id: 2, store_name: "Dos", status: "skipped", detail: "no change" },
        ] },
      },
    }));
    renderRoute(<OwnerCrossStoreDefaults />);
    await screen.findByText("uno");
    await userEvent.click(screen.getByRole("checkbox", { name: /^Federal tax rate/ }));
    const rate = screen.getByLabelText("Federal tax rate (%)");
    await userEvent.clear(rate);
    await userEvent.type(rate, "2.5");
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    await userEvent.click(screen.getByRole("button", { name: "Apply to 2 stores" }));
    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(callsTo(calls, "POST /api/v2/owner/cross-store-defaults")[0].body)
      .toEqual({ store_ids: [1, 2], federal_tax_rate: 0.025 });
  });

  it("refuses an out-of-range tax rate without calling the server", async () => {
    const calls = mockFetch(routes());
    renderRoute(<OwnerCrossStoreDefaults />);
    await screen.findByText("uno");
    await userEvent.click(screen.getByRole("checkbox", { name: /^Federal tax rate/ }));
    const rate = screen.getByLabelText("Federal tax rate (%)");
    await userEvent.clear(rate);
    await userEvent.type(rate, "150");
    await userEvent.click(screen.getByRole("checkbox", { name: /Uno/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply to 1 store" }));
    // The input's own max=100 (or the page's check) stops it.
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo(calls, "POST /api/v2/owner/cross-store-defaults")).toHaveLength(0);
  });

  it("shows a 422 from the server", async () => {
    mockFetch(routes({
      "POST /api/v2/owner/cross-store-defaults": {
        status: 422, body: { detail: "Unknown timezone." },
      },
    }));
    renderRoute(<OwnerCrossStoreDefaults />);
    await screen.findByText("uno");
    await userEvent.click(screen.getByRole("checkbox", { name: /^Timezone/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Uno/ }));
    await userEvent.click(screen.getByRole("button", { name: "Apply to 1 store" }));
    expect(await screen.findByText("Unknown timezone.")).toBeInTheDocument();
  });

  it("offers a retry when the stores fail to load", async () => {
    let fail = true;
    mockFetch(routes({
      "GET /api/v2/owner/locations": () => (fail ? { status: 500, body: {} } : { body: LOCATIONS }),
    }));
    renderRoute(<OwnerCrossStoreDefaults />);
    expect(await screen.findByText("Couldn't load your stores.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("uno")).toBeInTheDocument();
  });

  it("explains how to connect a store when there are none", async () => {
    mockFetch(routes({ "GET /api/v2/owner/locations": { body: { rows: [], total: 0, matched: 0 } } }));
    renderRoute(<OwnerCrossStoreDefaults />);
    expect(await screen.findByText(/don't have any stores connected/)).toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminStoreDrill from "./SuperadminStoreDrill";
import { ToastProvider } from "../components/ui";

// The superadmin store page's round-2 controls: a read-only "View
// as" next to "Sign in as", the comp plan modal + "End comp", and
// the Activity section fed by the store's own audit log.

const api = vi.fn();
const startImpersonation = vi.fn();
const compStore = vi.fn();
const endComp = vi.fn();
const useStoreAuditLog = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: (...args: unknown[]) => api(...args) };
});
vi.mock("../lib/impersonation", () => ({
  startImpersonation: (...args: unknown[]) => startImpersonation(...args),
}));
vi.mock("../api/superadmin", () => ({
  compStore: (...args: unknown[]) => compStore(...args),
  endComp: (...args: unknown[]) => endComp(...args),
  useStoreAuditLog: (...args: unknown[]) => useStoreAuditLog(...args),
  useStoreFeatures: () => ({ data: { rows: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
  useStoreOwnerLinks: () => ({ data: { rows: [] }, isLoading: false, isError: false, refetch: vi.fn() }),
  creditStore: vi.fn(), emailStore: vi.fn(), extendTrial: vi.fn(),
  freezeStore: vi.fn(), linkOwnerToStore: vi.fn(), toggleStoreActive: vi.fn(),
  unfreezeStore: vi.fn(), unlinkOwnerFromStore: vi.fn(),
}));
vi.mock("../api/account", () => ({
  useProfile: () => ({ data: { timezone: "" } }),
}));
vi.mock("../api/featureFlags", () => ({
  clearStoreOverride: vi.fn(), setStoreOverride: vi.fn(),
}));

function drill(overrides: Record<string, unknown> = {}) {
  return {
    store: {
      id: 7, name: "Cambio Express", slug: "cambio", email: "", phone: "",
      address: "", plan: "trial", billing_cycle: "", is_active: true,
      trial_status: "active", created_at: "2026-09-01T00:00:00",
      trial_ends_at: "2026-10-20T00:00:00", canceled_at: "",
      stripe_customer_id: "", frozen: false, frozen_at: "", frozen_reason: "",
      comped: false, comped_at: "", comp_reason: "",
      ...overrides,
    },
    team: [{
      id: 42, username: "maria", full_name: "Maria Lopez", role: "admin",
      email: "", is_active: true, has_2fa: false, last_login_at: "",
    }],
    roster: [], recent_transfers: [],
    stats_30d: { transfer_count: 0, volume: 0, fees: 0 },
  };
}

const permissions = {
  store_id: 7, store_name: "Cambio Express", roles: ["admin"], editable_roles: [],
  resources: [], actions: [], matrix: {}, has_overrides: [],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/superadmin/stores/7"]}>
          <Routes>
            <Route path="/superadmin/stores/:id" element={<SuperadminStoreDrill />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function mockDrill(overrides: Record<string, unknown> = {}) {
  api.mockImplementation((path: string) => {
    if (String(path).endsWith("/drill")) return Promise.resolve(drill(overrides));
    if (String(path).endsWith("/permissions")) return Promise.resolve(permissions);
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

beforeEach(() => {
  window.localStorage.setItem("db.identity", JSON.stringify({
    user_id: 1, username: "superadmin", full_name: "Platform Admin",
    role: "superadmin", store_id: null, permissions: [],
  }));
  api.mockReset();
  startImpersonation.mockReset();
  compStore.mockReset();
  endComp.mockReset();
  useStoreAuditLog.mockReset();
  useStoreAuditLog.mockReturnValue({
    data: { rows: [], total: 0, page: 1, per_page: 50, total_pages: 1 },
    isLoading: false, isError: false, refetch: vi.fn(),
  });
  mockDrill();
});

describe("<SuperadminStoreDrill> impersonation", () => {
  // The page navigates away on success, so each mode gets its own
  // render (the buttons stay busy once one has fired).
  it("'View as' starts a read-only session", async () => {
    renderPage();
    await screen.findByText("Maria Lopez");
    await userEvent.click(screen.getByRole("button", { name: "View as" }));
    expect(startImpersonation).toHaveBeenCalledWith(42, "read_only");
  });

  it("'Sign in as' starts a full session", async () => {
    renderPage();
    await screen.findByText("Maria Lopez");
    await userEvent.click(screen.getByRole("button", { name: "Sign in as" }));
    expect(startImpersonation).toHaveBeenCalledWith(42, "full");
  });
});

describe("<SuperadminStoreDrill> comp plan", () => {
  it("comps the store with the chosen plan and reason", async () => {
    compStore.mockResolvedValue({
      ok: true, plan: "basic", billing_cycle: "comp", comped: true,
      comped_at: "2026-10-08T00:00:00", comp_reason: "Design partner",
      stripe_paused: false, stripe_resumed: false,
    });
    renderPage();
    await screen.findByText("Maria Lopez");
    expect(screen.queryByRole("button", { name: "End comp" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Comp plan" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Plan"), "basic");
    await userEvent.type(within(dialog).getByLabelText(/reason/i), "Design partner");
    await userEvent.click(within(dialog).getByRole("button", { name: /comp this store/i }));
    await waitFor(() => expect(compStore).toHaveBeenCalledWith(7, { plan: "basic", reason: "Design partner" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a comped store shows the comp and offers to end it", async () => {
    mockDrill({ plan: "pro", comped: true, comped_at: "2026-10-01T00:00:00", comp_reason: "Make-good", stripe_customer_id: "cus_1" });
    endComp.mockResolvedValue({
      ok: true, plan: "pro", billing_cycle: "monthly", comped: false,
      comped_at: "", comp_reason: "", stripe_paused: false, stripe_resumed: true,
    });
    renderPage();
    await screen.findByText("Maria Lopez");
    expect(screen.getByText(/stripe collection is paused/i)).toBeInTheDocument();
    expect(screen.getByText(/reason: make-good/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Comp plan" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "End comp" }));
    await waitFor(() => expect(endComp).toHaveBeenCalledWith(7));
    expect(await screen.findByText(/billing resumed on the pro plan/i)).toBeInTheDocument();
  });

  it("shows the server's reason when the comp is refused", async () => {
    const { ApiError } = await import("../lib/api");
    compStore.mockRejectedValue(new ApiError(503, "Stripe is not configured.", null));
    renderPage();
    await screen.findByText("Maria Lopez");
    await userEvent.click(screen.getByRole("button", { name: "Comp plan" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /comp this store/i }));
    expect(await within(dialog).findByText("Stripe is not configured.")).toBeInTheDocument();
  });
});

describe("<SuperadminStoreDrill> activity", () => {
  it("lists the store's audit rows and drives the filters into the query", async () => {
    useStoreAuditLog.mockReturnValue({
      data: {
        rows: [{
          ts: "2026-10-08T14:00:00", user_name: "cashier (via superadmin Platform Admin)",
          user_role: "employee", action: "update", target_type: "transfer",
          target_id: "41", target_label: "Transfer #41", summary: "fee 5 → 6",
          source: "operator",
        }],
        total: 1, page: 1, per_page: 50, total_pages: 1,
      },
      isLoading: false, isError: false, refetch: vi.fn(),
    });
    renderPage();
    await screen.findByText("Maria Lopez");
    expect(screen.getByText("cashier (via superadmin Platform Admin)")).toBeInTheDocument();
    expect(useStoreAuditLog).toHaveBeenLastCalledWith(7, { page: 1, target: "", action: "" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Activity action" }), "lock");
    await waitFor(() => expect(useStoreAuditLog).toHaveBeenLastCalledWith(7, { page: 1, target: "", action: "lock" }));
  });
});

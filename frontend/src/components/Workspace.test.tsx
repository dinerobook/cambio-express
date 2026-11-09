import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "./AppShell";
import { PageCrumbs } from "./PageCrumbs";
import { workspaceForPath } from "./navConfig";
import { setLanguage } from "../i18n";
import {
  checksAvailable, hasBackOffice, rememberWorkspace, rememberedWorkspace,
  resetFirstLanding, workspaceFor,
} from "../lib/workspace";
import { mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";
import { ToastProvider } from "./ui/Toast";

// Check cashing is its own app inside DineroBook (navConfig
// "Workspaces", UI-STANDARDS §8): a "Back office | Check cashing"
// switch for stores that have it, a sidebar of its own, each
// person's last view remembered, and someone who may only cash
// checks always lands in it.

const session = vi.hoisted(() => ({ features: undefined as string[] | undefined }));

vi.mock("../api/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/account")>()),
  useProfile: () => ({ data: undefined }),
  useSessionStatus: () => ({
    data: session.features ? { features: session.features } : undefined,
  }),
  useStoreInfo: () => ({ data: undefined }),
}));
vi.mock("../api/support", () => ({
  useTicketsUnread: () => ({ data: { unread: 0 } }),
}));

const CASHIER = ["check_cashing.create", "check_cashing.read", "check_cashing.update"];
const ADMIN = [...TEST_ADMIN.permissions, ...CASHIER, "check_cashing_manage.update"];
const ON = ["check_desk", "module_money_services", "module_check_cashing"];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(at = "/dashboard") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <ToastProvider>
          <Routes>
            <Route path="*" element={<AppShell><Where /></AppShell>} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const rail = () => screen.getByRole("complementary", { name: "Primary navigation" });

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as never;
  mockFetch({
    "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
    "GET /api/v2/*": { body: {} },
  });
  window.localStorage.removeItem(`db.workspace.${TEST_ADMIN.user_id}`);
  resetFirstLanding();
  session.features = ON;
  signInAs({ permissions: ADMIN });
});

describe("which view a page belongs to", () => {
  it("puts every /check-cashing page in check cashing and keeps personal pages neutral", () => {
    expect(workspaceForPath("/check-cashing")).toBe("checks");
    expect(workspaceForPath("/check-cashing/customers/7")).toBe("checks");
    expect(workspaceForPath("/check-cashing-other")).toBe("backoffice");
    expect(workspaceForPath("/daily")).toBe("backoffice");
    expect(workspaceForPath("/settings/profile")).toBeNull();
    expect(workspaceForPath("/account/sessions")).toBeNull();
  });

  it("never shows check cashing without it, always for someone with nothing else", () => {
    const base = { available: true, backOffice: true, remembered: null };
    expect(workspaceFor("/check-cashing", { ...base, available: false })).toBe("backoffice");
    expect(workspaceFor("/daily", { ...base, backOffice: false })).toBe("checks");
    expect(workspaceFor("/settings/profile", { ...base, remembered: "checks" })).toBe("checks");
    expect(workspaceFor("/settings/profile", base)).toBe("backoffice");
  });

  it("offers check cashing only where the store has it and the person may use it", () => {
    expect(checksAvailable("admin", ADMIN, ON)).toBe(true);
    expect(checksAvailable("admin", ADMIN, ["module_money_services"])).toBe(false);
    expect(checksAvailable("admin", ADMIN, undefined)).toBe(false);
    expect(checksAvailable("employee", [], ON)).toBe(false);
  });

  it("tells a cashier with only check rights apart from back office staff", () => {
    expect(hasBackOffice("employee", CASHIER, ON)).toBe(false);
    expect(hasBackOffice("employee", [...CASHIER, "transfers.read"], ON)).toBe(true);
    expect(hasBackOffice("admin", ADMIN, ON)).toBe(true);
  });

  it("remembers the view per person and survives a blocked storage", () => {
    rememberWorkspace(1, "checks");
    expect(rememberedWorkspace(1)).toBe("checks");
    expect(rememberedWorkspace(2)).toBeNull();
    expect(rememberedWorkspace(undefined)).toBeNull();
  });
});

describe("the app switch", () => {
  it("moves between the back office and check cashing, sidebar and all", async () => {
    renderShell("/dashboard");
    const sw = screen.getAllByRole("group", { name: /Switch between/ })[0];
    expect(within(sw).getByRole("button", { name: "Back office" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(within(rail()).queryAllByText("Companies")).toEqual([]);

    await userEvent.click(within(sw).getByRole("button", { name: "Check cashing" }));
    expect(where()).toBe("/check-cashing");
    expect(within(rail()).getAllByText("Companies").length).toBeGreaterThan(0);
    expect(within(rail()).queryAllByText("Finance")).toEqual([]);
    expect(rememberedWorkspace(TEST_ADMIN.user_id)).toBe("checks");

    const again = screen.getAllByRole("group", { name: /Switch between/ })[0];
    await userEvent.click(within(again).getByRole("button", { name: "Back office" }));
    expect(where()).toBe("/dashboard");
    expect(rememberedWorkspace(TEST_ADMIN.user_id)).toBe("backoffice");
  });

  it("is not there for a store without check cashing", () => {
    session.features = ["module_money_services"];
    renderShell("/dashboard");
    expect(screen.queryByRole("group", { name: /Switch between/ })).not.toBeInTheDocument();
  });

  it("opens in check cashing after sign-in when that was the last view, once", async () => {
    rememberWorkspace(TEST_ADMIN.user_id, "checks");
    const first = renderShell("/dashboard");
    await waitFor(() => expect(where()).toBe("/check-cashing"));
    first.unmount();
    // Later in the same tab the dashboard is a choice and stays put.
    rememberWorkspace(TEST_ADMIN.user_id, "checks");
    renderShell("/dashboard");
    expect(where()).toBe("/dashboard");
  });

  it("always lands a check-only cashier in check cashing, with no switch", async () => {
    signInAs({ role: "employee", permissions: CASHIER });
    renderShell("/dashboard");
    await waitFor(() => expect(where()).toBe("/check-cashing"));
    expect(screen.queryByRole("group", { name: /Switch between/ })).not.toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    renderShell("/dashboard");
    const sw = screen.getAllByRole("group", { name: /Cambiar entre/ })[0];
    expect(within(sw).getByRole("button", { name: "Oficina" })).toBeInTheDocument();
    expect(within(sw).getByRole("button", { name: "Cambio de cheques" })).toBeInTheDocument();
  });
});

describe("check cashing trail", () => {
  it("starts a check cashing page's trail with the app", () => {
    renderRoute(<PageCrumbs current="Ana Ruiz" />, {
      path: "/check-cashing/customers/:id", at: "/check-cashing/customers/7",
    });
    const trail = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(trail).getByRole("link", { name: "Check cashing" }))
      .toHaveAttribute("href", "/check-cashing");
    expect(within(trail).getByRole("link", { name: "Customers" }))
      .toHaveAttribute("href", "/check-cashing/customers");
    expect(within(trail).getByText("Ana Ruiz")).toBeInTheDocument();
  });
});

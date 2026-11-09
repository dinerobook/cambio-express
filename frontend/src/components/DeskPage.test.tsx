import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeskPage } from "./DeskPage";
import CheckCashingSettings from "../routes/CheckCashingSettings";
import { setLanguage } from "../i18n";
import { ApiError } from "../lib/api";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";
import { TEST_ADMIN } from "../test/setup";
import appCss from "../styles.css?raw";
import frameCss from "./DeskPage.module.css?raw";

const routeSources = import.meta.glob<string>(
  ["../routes/Check*.tsx", "../routes/CashCheck*.tsx", "!../routes/*.test.tsx"],
  { query: "?raw", import: "default", eager: true },
);

// The check cashing app is a desk program on one computer
// (UI-STANDARDS §8; api/Modules/CheckCashing/INVARIANTS.md "One
// computer"): every page is a DeskPage that fills the window without
// page scrolling, refuses small screens, and shows a lock screen on
// any browser that is not the store's activated computer, where a
// manager can activate or move it.

const api = vi.hoisted(() => ({
  useCheckDevice: vi.fn(),
  activateCheckDevice: vi.fn(),
  switchOffCheckDevice: vi.fn(),
  useCheckSettings: vi.fn(),
  saveCheckSettings: vi.fn(),
}));

vi.mock("../api/checkCashing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/checkCashing")>()),
  ...api,
}));

const CASHIER = ["check_cashing.create", "check_cashing.read", "check_cashing.update"];
const MANAGER = [...CASHIER, "check_cashing_manage.update"];

const ok = <T,>(data: T) => ({
  data, isLoading: false, isError: false, error: null, isFetching: false, refetch: vi.fn(),
});

const device = (state: "this" | "other" | "none") => ({
  state, name: state === "none" ? "" : "Front counter",
  activated_at: "2026-11-09T10:00:00Z", activated_by: "Maria",
  last_seen_at: "2026-11-09T12:00:00Z",
});

function Page() {
  return <DeskPage><p>The page itself</p></DeskPage>;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  signInAs({ permissions: [...TEST_ADMIN.permissions, ...MANAGER] });
  api.useCheckDevice.mockReturnValue(ok(device("this")));
  api.useCheckSettings.mockReturnValue(ok({
    default_fee_kind: "percent", default_fee_value: 1, base_charge: null,
    base_charge_under: null, expired_id_mode: "warn", daily_limit: null,
  }));
});

afterEach(() => {
  // @ts-expect-error -- jsdom has no matchMedia; a test may add one
  delete window.matchMedia;
});

describe("the activated computer", () => {
  it("shows the page on the store's computer", () => {
    renderRoute(<Page />);
    expect(screen.getByText("The page itself")).toBeInTheDocument();
  });

  it("lets a manager activate a computer that is not set up yet", async () => {
    api.useCheckDevice.mockReturnValue(ok(device("none")));
    api.activateCheckDevice.mockResolvedValue(device("this"));
    renderRoute(<Page />);
    expect(screen.queryByText("The page itself")).not.toBeInTheDocument();
    expect(screen.getByText("This computer is not activated for check cashing")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Activate this computer" });
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^Name of this computer/), " Front counter ");
    await userEvent.click(go);
    await waitFor(() => expect(api.activateCheckDevice).toHaveBeenCalledWith("Front counter"));
  });

  it("asks before moving check cashing from another computer", async () => {
    api.useCheckDevice.mockReturnValue(ok(device("other")));
    api.activateCheckDevice.mockResolvedValue(device("this"));
    renderRoute(<Page />);
    expect(screen.getByText("Check cashing is locked to Front counter")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/^Name of this computer/), "Back room");
    await userEvent.click(screen.getByRole("button", { name: "Move check cashing here" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stop working on Front counter/)).toBeInTheDocument();
    expect(api.activateCheckDevice).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Move check cashing here" }));
    await waitFor(() => expect(api.activateCheckDevice).toHaveBeenCalledWith("Back room"));
  });

  it("shows the server's refusal (a phone) inside the screen", async () => {
    api.useCheckDevice.mockReturnValue(ok(device("none")));
    api.activateCheckDevice.mockRejectedValue(
      new ApiError(409, "Check cashing works on a desktop computer only.", {}),
    );
    renderRoute(<Page />);
    await userEvent.type(screen.getByLabelText(/^Name of this computer/), "Phone");
    await userEvent.click(screen.getByRole("button", { name: "Activate this computer" }));
    expect(await screen.findByText("Check cashing works on a desktop computer only."))
      .toBeInTheDocument();
  });

  it("tells a cashier to ask an Admin, with no activate button", () => {
    signInAs({ role: "employee", permissions: CASHIER });
    api.useCheckDevice.mockReturnValue(ok(device("other")));
    renderRoute(<Page />);
    expect(screen.getByText(/Ask an Admin to activate this computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move check cashing/ })).not.toBeInTheDocument();
  });

  it("refuses a small screen", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }) as never;
    renderRoute(<Page />);
    expect(screen.getByText("Check cashing works on a desktop computer")).toBeInTheDocument();
    expect(screen.queryByText("The page itself")).not.toBeInTheDocument();
  });

  it("is in Spanish", () => {
    setLanguage("es");
    api.useCheckDevice.mockReturnValue(ok(device("other")));
    renderRoute(<Page />);
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

describe("switching it off", () => {
  it("asks first on Settings, then switches off", async () => {
    api.switchOffCheckDevice.mockResolvedValue(device("none"));
    renderRoute(<CheckCashingSettings />);
    expect(screen.getByText(/Active on Front counter, activated by Maria/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Switch off check cashing here" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.switchOffCheckDevice).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch off check cashing here" }));
    await waitFor(() => expect(api.switchOffCheckDevice).toHaveBeenCalled());
    expect(await screen.findByText("Check cashing switched off on this computer.")).toBeInTheDocument();
  });
});

describe("no page scrolling", () => {
  const files = [
    "CashCheck.tsx", "CheckCustomers.tsx", "CheckCustomerForm.tsx",
    "CheckCompanies.tsx", "CheckCompanyForm.tsx", "CheckCashingSettings.tsx",
  ];

  it("puts every check cashing page in the desk frame, never PageShell", () => {
    const pages = Object.keys(routeSources).map((p) => p.replace("../routes/", ""));
    expect(pages.sort()).toEqual([...files].sort());
    for (const [f, src] of Object.entries(routeSources)) {
      expect(src, f).toMatch(/<DeskPage\b/);
      expect(src, f).not.toMatch(/<PageShell\b/);
    }
  });

  it("keeps the window from scrolling in the check cashing app", () => {
    expect(appCss).toMatch(/\.app-shell--desk \.app-content \{[^}]*overflow: hidden/);
    expect(appCss).toMatch(/\.app-shell--desk \.app-route \{[^}]*flex: 1/);
    expect(frameCss).toMatch(/\.page \{[^}]*overflow: hidden/);
    expect(frameCss).toMatch(/\.pane \{[^}]*overflow: auto/);
  });
});

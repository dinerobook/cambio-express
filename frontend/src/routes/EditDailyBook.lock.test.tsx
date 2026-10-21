import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
import styles from "./EditDailyBook.module.css";
import toolbarCss from "./EditDailyBook.module.css?raw";
import { setCurrentIdentity } from "../lib/auth";
import { setDisplayTimezone } from "../lib/datetime";
import { TEST_ADMIN } from "../test/setup";

// The MSB daily book's Lock / Unlock button follows the "Lock /
// unlock days" switch (day_lock.update) on Roles & access:
//   - with it, the button locks an open day and unlocks a locked one;
//   - without it, there is no button at all — an employee who may
//     edit the day still cannot lock it or re-open a locked one —
//     while the "Locked" marker still shows.

const DAY = "2026-10-06";

const useDailyReport = vi.fn();
const lockDailyReport = vi.fn();
const unlockDailyReport = vi.fn();
const updateDailyReport = vi.fn();

vi.mock("../api/dailybook", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dailybook")>();
  return {
    ...real,
    useDailyReport: () => useDailyReport(),
    useLineItems: () => LINES,
    useMTBreakdown: () => MT,
    useOpenSettlements: () => NOTHING_OPEN,
    lockDailyReport: (...a: unknown[]) => lockDailyReport(...a),
    unlockDailyReport: (...a: unknown[]) => unlockDailyReport(...a),
    updateDailyReport: (...a: unknown[]) => updateDailyReport(...a),
  };
});

vi.mock("../api/account", () => ({
  useStoreInfo: () => STORE_INFO,
  useSessionStatus: () => SESSION,
}));

// Stable objects: the page syncs local drafts from these in effects.
const MT = { data: { rows: [] }, isLoading: false, isFetching: false };
const LINES = { data: { items: [] } };
const NOTHING_OPEN = { data: [], isError: false };
const STORE_INFO = { data: { store: { sales_tax_rate: 0 } } };
const SESSION = { data: undefined };
const OPEN_DAY = { data: null, isLoading: false, isFetching: false };
// A saved, locked day: every money field zero.
const LOCKED_REPORT = new Proxy(
  { locked: true, locked_at: `${DAY}T20:00:00`, notes: "", report_date: DAY },
  { get: (t, k) => (k in t ? t[k as keyof typeof t] : 0) },
);
const LOCKED_DAY = { data: LOCKED_REPORT, isLoading: false, isFetching: false };

const EDITOR = {
  ...TEST_ADMIN, role: "employee",
  permissions: ["daily_book.read", "daily_book.update", "daily_book.create"],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/daily/edit?date=${DAY}`]}>
        <EditDailyBook />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useDailyReport.mockReset();
  lockDailyReport.mockReset().mockResolvedValue({});
  unlockDailyReport.mockReset().mockResolvedValue({});
  updateDailyReport.mockReset().mockResolvedValue({});
});

describe("Daily book lock button", () => {
  it("locks an open day for someone with the switch", async () => {
    useDailyReport.mockReturnValue(OPEN_DAY);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Lock" }));
    // Saves the day first so the lock never freezes stale edits.
    await waitFor(() => expect(lockDailyReport).toHaveBeenCalledWith(1, DAY));
    expect(updateDailyReport).toHaveBeenCalled();
  });

  it("unlocks a locked day for someone with the switch", async () => {
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(unlockDailyReport).toHaveBeenCalledWith(1, DAY));
  });

  it("gives an editor without the switch no Lock button", async () => {
    setCurrentIdentity(EDITOR);
    useDailyReport.mockReturnValue(OPEN_DAY);
    renderPage();
    await screen.findByRole("button", { name: /Save/ });
    expect(screen.queryByRole("button", { name: "Lock" })).not.toBeInTheDocument();
  });

  it("gives an editor without the switch no way to unlock", async () => {
    setCurrentIdentity(EDITOR);
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    expect(await screen.findByText(/Locked ·/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unlock" })).not.toBeInTheDocument();
    expect(unlockDailyReport).not.toHaveBeenCalled();
  });

  it("shows the button again once the switch is granted", async () => {
    setCurrentIdentity({ ...EDITOR, permissions: [...EDITOR.permissions, "day_lock.update"] });
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });

  it("shows the lock time on the store's clock", async () => {
    // The owner's report: locked at 3:00 PM Chicago, stored as 20:00
    // UTC with no offset, shown as 8:00 PM (the UTC wall clock read
    // as local time). It must read 3:00 PM for a Chicago store.
    setDisplayTimezone("America/Chicago");
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    expect(await screen.findByText("Locked · Oct 6, 3:00 PM")).toBeInTheDocument();
  });

  it("shows the same lock in another store's timezone", async () => {
    setDisplayTimezone("America/Los_Angeles");
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    expect(await screen.findByText("Locked · Oct 6, 1:00 PM")).toBeInTheDocument();
  });
});

// The owner's report: on desktop the day stepper slid left whenever
// the right side of the toolbar grew (a "Saved" or "Locked" pill,
// Lock → Unlock), so the arrows moved under the cursor while stepping
// through days. The toolbar is three tracks: the two outer ones are
// always equal, so the stepper sits dead centre whatever the right
// side holds. jsdom doesn't lay out or evaluate media queries, so the
// structure is checked on the rendered page and the grid on the
// stylesheet itself.
describe("Daily book day stepper position", () => {
  function toolbarParts() {
    const stepper = screen.getByRole("button", { name: "Previous day" }).parentElement!;
    const toolbar = stepper.parentElement!;
    return { toolbar, stepper, parts: Array.from(toolbar.children) };
  }

  function expectCentred() {
    const { toolbar, stepper, parts } = toolbarParts();
    expect(toolbar).toHaveClass(styles.toolbar);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveClass(styles.toolbarLead);
    expect(parts[1]).toBe(stepper);
    expect(parts[2]).toHaveClass(styles.toolbarTrail);
    return parts[2] as HTMLElement;
  }

  it("keeps the stepper in the middle track on an open day", async () => {
    useDailyReport.mockReturnValue(OPEN_DAY);
    renderPage();
    await screen.findByRole("button", { name: "Lock" });
    expectCentred();
  });

  it("keeps it there once the day is saved", async () => {
    useDailyReport.mockReturnValue(OPEN_DAY);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Save/ }));
    expect(await screen.findByText(/^Saved /)).toBeInTheDocument();
    const trail = expectCentred();
    expect(trail).toHaveTextContent(/Saved /);
  });

  it("keeps it there on a locked day", async () => {
    useDailyReport.mockReturnValue(LOCKED_DAY);
    renderPage();
    await screen.findByRole("button", { name: "Unlock" });
    const trail = expectCentred();
    expect(trail).toHaveTextContent(/Locked ·/);
  });

  it("keeps it there when there is no lock button at all", async () => {
    setCurrentIdentity(EDITOR);
    useDailyReport.mockReturnValue(OPEN_DAY);
    renderPage();
    await screen.findByRole("button", { name: /Save/ });
    expectCentred();
  });

  it("lays the desktop toolbar out as two equal sides around the stepper", () => {
    const style = document.createElement("style");
    style.textContent = toolbarCss;
    document.head.appendChild(style);
    try {
      const desktop = Array.from(style.sheet!.cssRules).find(
        (r): r is CSSMediaRule => r instanceof CSSMediaRule
          && r.media.mediaText === "(min-width: 78rem)"
          && r.cssText.includes(".toolbar "),
      );
      expect(desktop).toBeDefined();
      const rule = (sel: string) => Array.from(desktop!.cssRules).find(
        (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText === sel,
      )!.style;
      expect(rule(".toolbar").display).toBe("grid");
      // Equal outer tracks that may shrink to 0: a wide right side
      // wraps inside its own track instead of pushing the middle.
      expect(rule(".toolbar").gridTemplateColumns)
        .toBe("minmax(0, 1fr) auto minmax(0, 1fr)");
      expect(rule(".toolbarLead").justifySelf).toBe("start");
      expect(rule(".toolbarTrail").justifySelf).toBe("end");
    } finally {
      style.remove();
    }
  });
});

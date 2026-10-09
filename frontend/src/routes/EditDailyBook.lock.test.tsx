import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import EditDailyBook from "./EditDailyBook";
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

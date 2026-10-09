import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StoreBookDay from "./StoreBookDay";
import { ToastProvider } from "../components/ui";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// The store daily book's Lock day / Unlock button needs Edit on the
// store daily book AND the "Lock / unlock days" switch — the same
// pair the server's lock route checks. Without the switch the
// button is gone and the locked banner says an admin has to unlock.

const DAY = "2026-08-02";

const useStoreBookDay = vi.fn();
const setStoreBookLock = vi.fn();

vi.mock("../api/storebook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/storebook")>()),
  useStoreBookDay: () => useStoreBookDay(),
  setStoreBookLock: (...a: unknown[]) => setStoreBookLock(...a),
}));

vi.mock("../components/RegisterCloses", () => ({ default: () => null }));

const sheet = (is_locked: boolean) => ({
  store_id: 1, entry_date: DAY, values: {}, counts: {}, originals: {},
  notes: "", layout: [], is_locked,
  locked_at: is_locked ? `${DAY}T20:00:00` : null,
});
const OPEN = { data: sheet(false), isLoading: false, isError: false, refetch: vi.fn() };
const LOCKED = { data: sheet(true), isLoading: false, isError: false, refetch: vi.fn() };

const EDITOR = {
  ...TEST_ADMIN, role: "employee",
  permissions: ["day_close.read", "day_close.create", "day_close.update"],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/store-book/day?date=${DAY}`]}>
          <StoreBookDay />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useStoreBookDay.mockReset();
  setStoreBookLock.mockReset();
});

describe("Store daily book lock button", () => {
  it("locks the day after confirming, for someone with the switch", async () => {
    useStoreBookDay.mockReturnValue(OPEN);
    setStoreBookLock.mockResolvedValue(sheet(true));
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Lock day" }));
    // The confirm dialog's own button.
    const confirm = screen.getAllByRole("button", { name: "Lock day" }).at(-1)!;
    await user.click(confirm);
    await waitFor(() => expect(setStoreBookLock).toHaveBeenCalledWith(DAY, true));
  });

  it("unlocks a locked day for someone with the switch", async () => {
    useStoreBookDay.mockReturnValue(LOCKED);
    setStoreBookLock.mockResolvedValue(sheet(false));
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByText(/Unlock it to make changes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(setStoreBookLock).toHaveBeenCalledWith(DAY, false));
  });

  it("gives an editor without the switch no Lock day button", () => {
    setCurrentIdentity(EDITOR);
    useStoreBookDay.mockReturnValue(OPEN);
    renderPage();
    expect(screen.queryByRole("button", { name: "Lock day" })).not.toBeInTheDocument();
  });

  it("gives an editor without the switch no way to unlock", () => {
    setCurrentIdentity(EDITOR);
    useStoreBookDay.mockReturnValue(LOCKED);
    renderPage();
    expect(screen.queryByRole("button", { name: "Unlock" })).not.toBeInTheDocument();
    expect(screen.getByText(/Ask an admin to unlock it/)).toBeInTheDocument();
    expect(setStoreBookLock).not.toHaveBeenCalled();
  });

  it("needs Edit on the store daily book as well as the switch", () => {
    setCurrentIdentity({
      ...TEST_ADMIN, role: "employee",
      permissions: ["day_close.read", "day_lock.update"],
    });
    useStoreBookDay.mockReturnValue(LOCKED);
    renderPage();
    expect(screen.queryByRole("button", { name: "Unlock" })).not.toBeInTheDocument();
  });
});

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OwnerConnect from "./OwnerConnect";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { OwnerConnectCodeRow } from "../api/owner";

// Owner connect codes link a store to an owner's umbrella — the
// gate to every cross-store view. Pinned: owners only; one active
// code at a time (generating revokes the current one FIRST);
// revoke / replace go through a confirm; refusals are visible.

const generateOwnerConnectCode = vi.fn();
const revokeOwnerConnectCode = vi.fn();
const refetch = vi.fn();
let state: {
  data?: { rows: OwnerConnectCodeRow[]; total: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/owner", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/owner")>();
  return {
    ...real,
    useOwnerConnectCodes: () => ({ ...state, refetch }),
    generateOwnerConnectCode: () => generateOwnerConnectCode(),
    revokeOwnerConnectCode: (id: number) => revokeOwnerConnectCode(id),
  };
});

function code(id: number, c: string, over: Partial<OwnerConnectCodeRow> = {}): OwnerConnectCodeRow {
  return {
    id, code: c, created_at: "2026-10-01T00:00:00", expires_at: "2026-10-15T00:00:00",
    used_at: "", used_by_store_name: "", revoked_at: "",
    is_redeemed: false, is_revoked: false, is_expired: false, ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <OwnerConnect />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("OwnerConnect", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "owner", store_id: null });
    generateOwnerConnectCode.mockReset();
    generateOwnerConnectCode.mockResolvedValue(code(9, "NEWCODE1"));
    revokeOwnerConnectCode.mockReset();
    revokeOwnerConnectCode.mockResolvedValue(undefined);
    refetch.mockReset();
    state = {
      data: {
        rows: [
          code(1, "OLDUSED1", { is_redeemed: true, used_by_store_name: "North", used_at: "2026-09-01T00:00:00" }),
          code(2, "EXPIRED1", { is_expired: true }),
          code(3, "ACTIVE01"),
        ],
        total: 3,
      },
      isLoading: false, isError: false,
    };
  });

  it("is closed to anyone but an owner", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText("Only owners can mint store-connect codes.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate/ })).not.toBeInTheDocument();
  });

  it("shows the active code and the redeemed history", () => {
    renderPage();
    expect(screen.getByDisplayValue("ACTIVE01")).toBeInTheDocument();
    const redeemedRow = screen.getByText("OLDUSED1").closest("tr")!;
    expect(within(redeemedRow).getByText("North")).toBeInTheDocument();
    expect(screen.queryByText("EXPIRED1")).not.toBeInTheDocument();
  });

  it("generates a first code after the confirm when none is active", async () => {
    state = { data: { rows: [], total: 0 }, isLoading: false, isError: false };
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Generate Invite Code" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generateOwnerConnectCode).toHaveBeenCalledTimes(1));
    expect(revokeOwnerConnectCode).not.toHaveBeenCalled();
  });

  it("revokes the active code before minting its replacement", async () => {
    const order: string[] = [];
    revokeOwnerConnectCode.mockImplementation(async (id: number) => { order.push(`revoke ${id}`); });
    generateOwnerConnectCode.mockImplementation(async () => { order.push("generate"); });
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Generate New Code" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the current code?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(order).toEqual(["revoke 3", "generate"]));
  });

  it("revokes the active code after the confirm", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeOwnerConnectCode).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "Revoke this code?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeOwnerConnectCode).toHaveBeenCalledWith(3));
  });

  it("does not mint a new code when revoking the old one is refused", async () => {
    revokeOwnerConnectCode.mockRejectedValue(new ApiError(409, "Code already redeemed.", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Generate New Code" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Replace" }));
    expect(await screen.findByText("Code already redeemed.")).toBeInTheDocument();
    expect(generateOwnerConnectCode).not.toHaveBeenCalled();
  });

  it("shows ErrorState with a working Retry when codes fail to load", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "DB down", null) };
    renderPage();
    expect(screen.getByText(/Couldn't load codes\. DB down/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  // Generating while the list is unknown would skip revoking the live code.
  it("does not offer Generate while the codes failed to load", () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "DB down", null) };
    renderPage();
    expect(screen.queryByRole("button", { name: "Generate Invite Code" })).not.toBeInTheDocument();
  });
});

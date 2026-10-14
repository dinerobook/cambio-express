import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

import { SettingsSecurity } from "./Settings";
import { ToastProvider } from "../components/ui";

// Security → "Download my data". It goes through the shared download
// path: an expired session refreshes and retries like every API call,
// and a failure is a toast, not an uncaught promise with the button
// quietly re-enabling.

vi.mock("../api/account", () => ({
  useProfile: () => ({ data: undefined, isLoading: true }),
  useStoreInfo: () => ({ data: undefined }),
  usePasskeys: () => ({ data: { passkeys: [] }, isLoading: false }),
  changePassword: vi.fn(), deletePasskey: vi.fn(), registerPasskey: vi.fn(),
  updateProfile: vi.fn(), updateStoreInfo: vi.fn(),
}));
vi.mock("../api/owner", () => ({ redeemConnectCode: vi.fn() }));

const fetchMock = vi.fn();
const createObjectURL = vi.fn(() => "blob:x");

function renderCard() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter><SettingsSecurity /></MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const button = () => screen.getByRole("button", { name: /Download my data/ });

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  createObjectURL.mockClear();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Download my data", () => {
  it("refreshes an expired session, then downloads", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: 1 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: { "Content-Disposition": 'attachment; filename="me.json"' },
      }));
    renderCard();
    await userEvent.click(button());
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map(([p]) => String(p))).toEqual([
      "/api/v2/auth/account/export",
      "/api/v2/auth/refresh",
      "/api/v2/auth/account/export",
    ]);
  });

  it("toasts a failure and frees the button", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    renderCard();
    await userEvent.click(button());
    expect(await screen.findByText(/Download failed \(500\)|Could not download your data/))
      .toBeInTheDocument();
    expect(button()).toBeEnabled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

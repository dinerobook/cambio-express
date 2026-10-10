import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminMaintenance from "./SuperadminMaintenance";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";

// One switch takes the whole platform down. Pinned: the form
// hydrates from the server, Save posts the switch + trimmed message,
// and a refusal is shown on the page.

const api = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return { ...real, api: (...a: unknown[]) => api(...a) };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SuperadminMaintenance />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function serve(get: () => Promise<unknown>, post: () => Promise<unknown> = async () => ({})) {
  api.mockImplementation((_url: string, opts?: { method?: string }) =>
    opts?.method === "POST" ? post() : get());
}

describe("SuperadminMaintenance", () => {
  beforeEach(() => {
    api.mockReset();
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
  });

  it("hydrates the switch and message from the server", async () => {
    serve(async () => ({ enabled: true, message: "Back at 4 AM" }));
    renderPage();
    expect(await screen.findByText("Maintenance mode is ON")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Maintenance message/)).toHaveValue("Back at 4 AM");
  });

  it("does not fetch for a non-superadmin", () => {
    setCurrentIdentity(TEST_ADMIN);
    serve(async () => ({ enabled: true, message: "" }));
    renderPage();
    expect(api).not.toHaveBeenCalled();
  });

  it("turns maintenance on with the trimmed message", async () => {
    serve(async () => ({ enabled: false, message: "" }));
    renderPage();
    await screen.findByText("Platform is operational");
    await userEvent.click(screen.getByRole("switch"));
    await userEvent.type(screen.getByLabelText(/^Maintenance message/), "  Upgrading DB  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/v2/superadmin/maintenance", {
      method: "POST", json: { enabled: true, message: "Upgrading DB" },
    }));
    expect(await screen.findByText(/Maintenance mode ON/)).toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    serve(
      async () => ({ enabled: false, message: "" }),
      async () => { throw new ApiError(403, "Superadmin only.", null); },
    );
    renderPage();
    await screen.findByText("Platform is operational");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Superadmin only.");
  });

  // BUG: SuperadminMaintenance.tsx ignores the query's error state.
  // When GET /superadmin/maintenance fails, the page still renders
  // the form with its defaults ("Platform is operational", switch
  // Off, empty message) and an enabled Save — so a superadmin who
  // clicks Save while maintenance is actually ON silently turns it
  // OFF and wipes the message. Expected: an <ErrorState> with Retry
  // and no form.
  it.fails("shows an ErrorState instead of a default form when loading fails", async () => {
    serve(async () => { throw new ApiError(500, "Server error", null); });
    renderPage();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });
});

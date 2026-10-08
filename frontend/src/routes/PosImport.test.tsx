import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PosImport from "./PosImport";
import { ToastProvider } from "../components/ui";
import { ApiError } from "../lib/api";

// Revoking a site-agent key stops that back-office PC uploading
// register journals at once, so it goes through a confirm dialog
// (UI-STANDARDS §2: destructive action = ConfirmDialog). It used
// to fire on the first click.

const revokeAgentKey = vi.fn();

vi.mock("../api/posimport", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/posimport")>();
  return {
    ...real,
    revokeAgentKey: (...a: unknown[]) => revokeAgentKey(...a),
    useStagedDays: () => ({ data: { days: [] }, isLoading: false, isError: false }),
    useAgentKeys: () => ({
      data: {
        keys: [
          { id: 7, label: "Back office PC", created_at: "2026-10-01T10:00:00Z",
            last_used_at: null, revoked: false },
          { id: 8, label: "Old PC", created_at: "2026-09-01T10:00:00Z",
            last_used_at: null, revoked: true },
        ],
      },
      isLoading: false, isError: false,
    }),
  };
});

vi.mock("../api/dayclose", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/dayclose")>();
  return {
    ...real,
    useDepartments: () => ({ data: { departments: [] }, isLoading: false, isError: false }),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <PosImport />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PosImport agent key revoke", () => {
  beforeEach(() => {
    revokeAgentKey.mockReset();
  });

  it("offers Revoke only on active keys", () => {
    renderPage();
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("asks before revoking and does nothing on cancel", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Revoke "Back office PC"?');
    expect(revokeAgentKey).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(revokeAgentKey).not.toHaveBeenCalled();
  });

  it("revokes the chosen key on confirm", async () => {
    revokeAgentKey.mockResolvedValue({});
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(revokeAgentKey).toHaveBeenCalledWith(7));
    expect(await screen.findByText("Agent key revoked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the server's error on failure", async () => {
    revokeAgentKey.mockRejectedValue(new ApiError(409, "Key already revoked", null));
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    // The open dialog marks the rest of the page aria-hidden, toasts included.
    expect(await screen.findByRole("alert", { hidden: true }))
      .toHaveTextContent("Key already revoked");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

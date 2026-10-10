import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SuperadminAnnouncements from "./SuperadminAnnouncements";
import { ApiError } from "../lib/api";
import { setCurrentIdentity } from "../lib/auth";
import { TEST_ADMIN } from "../test/setup";
import type { AnnouncementRow } from "../api/announcements";

// Platform banners (and optional email blast to every opted-in
// user). Pinned: superadmin only; the create body (trimmed message,
// level, expiry, broadcast, audience); "Specific stores" with none
// picked is refused client-side; toggle flips is_active; delete goes
// through a confirm; refusals show.

const createAnnouncement = vi.fn();
const toggleAnnouncement = vi.fn();
const deleteAnnouncement = vi.fn();
const refetch = vi.fn();
let state: {
  data?: { rows: AnnouncementRow[]; total: number };
  isLoading: boolean; isError: boolean; error?: unknown;
};

vi.mock("../api/announcements", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/announcements")>();
  return {
    ...real,
    useAnnouncements: () => ({ ...state, refetch }),
    createAnnouncement: (...a: unknown[]) => createAnnouncement(...a),
    toggleAnnouncement: (...a: unknown[]) => toggleAnnouncement(...a),
    deleteAnnouncement: (...a: unknown[]) => deleteAnnouncement(...a),
  };
});
vi.mock("../api/superadmin", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/superadmin")>();
  return {
    ...real,
    useSuperadminStores: () => ({
      data: {
        rows: [
          { store_id: 4, name: "North", slug: "north", plan: "pro" },
          { store_id: 5, name: "South", slug: "south", plan: "trial" },
        ],
        total: 2,
      },
      isLoading: false, isError: false,
    }),
  };
});

function ann(id: number, message: string, over: Partial<AnnouncementRow> = {}): AnnouncementRow {
  return {
    id, message, level: "info", is_active: true, is_visible: true,
    created_at: "2026-10-01T00:00:00", created_by: 1, expires_at: "",
    starts_at: "", broadcast_requested: false, broadcast_sent_at: "",
    target_store_ids: [], target_store_names: [], ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SuperadminAnnouncements />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowOf = (msg: string) => screen.getByText(msg).closest("tr")!;

describe("SuperadminAnnouncements", () => {
  beforeEach(() => {
    setCurrentIdentity({ ...TEST_ADMIN, role: "superadmin", store_id: null });
    for (const fn of [createAnnouncement, toggleAnnouncement, deleteAnnouncement]) {
      fn.mockReset();
      fn.mockResolvedValue({});
    }
    refetch.mockReset();
    state = {
      data: {
        rows: [
          ann(1, "Maintenance Friday"),
          ann(2, "Old notice", {
            is_active: false, is_visible: false,
            broadcast_requested: true, broadcast_sent_at: "",
            target_store_ids: [4], target_store_names: ["North"],
          }),
        ],
        total: 2,
      },
      isLoading: false, isError: false,
    };
  });

  it("is closed to anyone but a superadmin", () => {
    setCurrentIdentity(TEST_ADMIN);
    renderPage();
    expect(screen.getByText("Superadmin scope required.")).toBeInTheDocument();
  });

  it("lists banners with status, audience and broadcast state", () => {
    renderPage();
    expect(within(rowOf("Maintenance Friday")).getByText("live")).toBeInTheDocument();
    expect(within(rowOf("Maintenance Friday")).getByText("All stores")).toBeInTheDocument();
    const old = rowOf("Old notice");
    expect(within(old).getByText("disabled")).toBeInTheDocument();
    expect(within(old).getByText("1 store")).toBeInTheDocument();
    expect(within(old).getByText("pending")).toBeInTheDocument();
  });

  it("shows ErrorState with a working Retry", async () => {
    state = { isLoading: false, isError: true, error: new ApiError(500, "List failed", null) };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("List failed");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("posts a global banner with the form's values", async () => {
    renderPage();
    const post = screen.getByRole("button", { name: "Post banner" });
    expect(post).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Message"), "  Rates updated  ");
    await userEvent.selectOptions(screen.getByLabelText("Level"), "warning");
    await userEvent.clear(screen.getByLabelText("Expires (days)"));
    await userEvent.type(screen.getByLabelText("Expires (days)"), "7");
    await userEvent.click(screen.getByRole("checkbox", { name: /Also email opted-in users/ }));
    await userEvent.click(post);
    await waitFor(() => expect(createAnnouncement).toHaveBeenCalledWith({
      message: "Rates updated", level: "warning", expires_days: 7, broadcast: true,
      start_at_iso: "", target_store_ids: [],
    }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue(""));
  });

  it("refuses 'Specific stores' with none picked, without calling the API", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Message"), "Hi");
    await userEvent.click(screen.getByRole("radio", { name: "Specific stores" }));
    await userEvent.click(screen.getByRole("button", { name: "Post banner" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick at least one store");
    expect(createAnnouncement).not.toHaveBeenCalled();
  });

  it("targets only the picked stores", async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText("Message"), "Hi South");
    await userEvent.click(screen.getByRole("radio", { name: "Specific stores" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /South/ }));
    await userEvent.click(screen.getByRole("button", { name: "Post banner" }));
    await waitFor(() => expect(createAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ target_store_ids: [5] }),
    ));
  });

  it("shows a refused post and keeps the message", async () => {
    createAnnouncement.mockRejectedValue(new ApiError(422, "Message too long.", null));
    renderPage();
    await userEvent.type(screen.getByLabelText("Message"), "Hello");
    await userEvent.click(screen.getByRole("button", { name: "Post banner" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message too long.");
    expect(screen.getByLabelText("Message")).toHaveValue("Hello");
  });

  it("toggles a banner to the opposite state", async () => {
    renderPage();
    await userEvent.click(within(rowOf("Old notice")).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(toggleAnnouncement).toHaveBeenCalledWith(2, true));
  });

  it("deletes only after the confirm", async () => {
    renderPage();
    await userEvent.click(within(rowOf("Maintenance Friday")).getByRole("button", { name: "Delete" }));
    expect(deleteAnnouncement).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteAnnouncement).toHaveBeenCalledWith(1));
  });

  // A refused delete keeps the dialog open, so the refusal must show inside it.
  it("shows a refused delete inside the still-open dialog", async () => {
    deleteAnnouncement.mockRejectedValue(new ApiError(409, "Broadcast in progress.", null));
    renderPage();
    await userEvent.click(within(rowOf("Maintenance Friday")).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteAnnouncement).toHaveBeenCalled());
    expect(await within(screen.getByRole("dialog")).findByText("Broadcast in progress."))
      .toBeInTheDocument();
  });
});

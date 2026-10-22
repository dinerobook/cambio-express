import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AccountNotifications from "./AccountNotifications";
import { ApiError } from "../lib/api";
import { renderRouteWithGuard } from "../test/renderRoute";

// Account → Notifications (per-person email / push switches). It had
// no tests. Pinned: the switches load from the server, an edit shows
// Unsaved changes and holds a navigation away, Save sends the draft
// and clears the bar, a refused save keeps both, and a failed load
// offers Retry instead of a form of defaults.

const useNotifications = vi.fn();
const updateNotifications = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useNotifications: () => useNotifications(),
    updateNotifications: (...a: unknown[]) => updateNotifications(...a),
    usePushStatus: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock("../lib/push", () => ({
  getPushPermission: () => "default",
  hasLocalSubscription: () => Promise.resolve(false),
  pushSupported: () => false,
  subscribeBrowser: vi.fn(),
  unsubscribeBrowser: vi.fn(),
}));

const PREFS = {
  notify_trial_reminders: true, notify_announcement_email: false,
  notify_locked_day_digest: true, notify_daily_summary: true,
  notify_trial_reminders_push: false, notify_announcement_push: true,
  notify_locked_day_digest_push: false, notify_daily_summary_push: false,
  notify_high_variance: false, notify_high_variance_push: false,
  notify_store_offline: false, notify_store_offline_push: false,
  notify_ticket_updates: true, notify_ticket_updates_push: false,
  notify_new_sign_in: true, notify_new_sign_in_push: true,
  ticket_updates_applies: true, trial_toggle_applies: true,
  locked_day_digest_applies: true, daily_summary_applies: true,
  high_variance_applies: true, store_offline_applies: true,
  role: "admin",
};

const refetch = vi.fn();
beforeEach(() => {
  refetch.mockReset();
  useNotifications.mockReturnValue({
    data: PREFS, isLoading: false, isError: false, error: null, refetch,
  });
  updateNotifications.mockReset().mockResolvedValue(PREFS);
});

const announcementEmail = () =>
  screen.getByRole("checkbox", { name: "Email — Platform announcements" });

function renderPage() {
  return renderRouteWithGuard(<AccountNotifications />, { path: "/account/notifications" });
}

describe("AccountNotifications", () => {
  it("loads each switch from the server, clean", () => {
    renderPage();
    expect(announcementEmail()).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Push — Platform announcements" })).toBeChecked();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("an edit shows Unsaved changes and holds a navigation away", async () => {
    const { router } = renderPage();
    await userEvent.click(announcementEmail());
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    act(() => { void router.navigate("/dashboard"); });
    expect(await screen.findByText(
      "You have unsaved notification preferences. Leave without saving?",
    )).toBeInTheDocument();
  });

  it("Save sends the switches and clears the bar", async () => {
    renderPage();
    await userEvent.click(announcementEmail());
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ notify_announcement_email: true }),
    ));
    expect(await screen.findByText("Notification preferences saved.")).toBeInTheDocument();
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("a refused save shows why and keeps the edit", async () => {
    updateNotifications.mockRejectedValue(new ApiError(400, "Push is off for this store.", null));
    renderPage();
    await userEvent.click(announcementEmail());
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("Push is off for this store.")).toBeInTheDocument();
    expect(announcementEmail()).toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("the new sign-in alert loads from the server and saves when switched off", async () => {
    renderPage();
    const email = screen.getByRole("checkbox", { name: "Email — New sign-in alert" });
    const push = screen.getByRole("checkbox", { name: "Push — New sign-in alert" });
    expect(email).toBeChecked();
    expect(push).toBeChecked();
    await userEvent.click(email);
    await userEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ notify_new_sign_in: false, notify_new_sign_in_push: true }),
    ));
  });

  it("an alert never switched on shows off and can be switched on", async () => {
    useNotifications.mockReturnValue({
      data: { ...PREFS, notify_new_sign_in: false, notify_new_sign_in_push: false },
      isLoading: false, isError: false, error: null, refetch,
    });
    renderPage();
    const email = screen.getByRole("checkbox", { name: "Email — New sign-in alert" });
    expect(email).not.toBeChecked();
    expect(email).toBeEnabled();
    await userEvent.click(email);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("a failed load offers Retry, not a form of defaults", async () => {
    useNotifications.mockReturnValue({
      data: undefined, isLoading: false, isError: true,
      error: new ApiError(500, "down", null), refetch,
    });
    renderPage();
    expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });
});

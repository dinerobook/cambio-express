import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { BellItem, BellResponse } from "../api/bell";
import { callsTo, mockFetch } from "../test/fetchMock";
import { renderRoute, signInAs } from "../test/renderRoute";
import { NotificationBell } from "./NotificationBell";
import bellCss from "./NotificationBell.module.css?raw";
import badgeCss from "./ui/CountBadge.module.css?raw";

const BELL = "GET /api/v2/notifications/bell";
const DISMISS = "POST /api/v2/notifications/bell/dismiss";
const UNDISMISS = "POST /api/v2/notifications/bell/undismiss";

const STORE_DAY = "2026-11-04";

const UNLOCKED: BellItem = {
  key: "daily_book.unlocked", kind: "daily_book.unlocked", urgency: "due",
  count: 1, day: "2026-11-03", amount_cents: null, view: null,
};
const DUE_BACK: BellItem = {
  key: "daily_book.due_back", kind: "daily_book.due_back", urgency: "overdue",
  count: 2, day: "2026-11-01", amount_cents: 75_000, view: null,
};
const BANK: BellItem = {
  key: "bank.to_check", kind: "bank.to_check", urgency: "due",
  count: 4, day: null, amount_cents: null, view: "uncategorized",
};
const CHECKS: BellItem = {
  key: "return_checks.pending", kind: "return_checks.pending",
  urgency: "overdue", count: 1, day: "2026-09-20", amount_cents: 30_000,
  view: null,
};

function answer(items: BellItem[], extra: Partial<BellResponse> = {}): BellResponse {
  return {
    enabled: true, store_day: STORE_DAY, can_dismiss: true, items, ...extra,
  };
}

function show() {
  return renderRoute(<NotificationBell />, { path: "/", at: "/" });
}

async function bell() {
  return screen.findByTestId("notification-bell");
}

async function openPanel() {
  const user = userEvent.setup();
  await user.click(await bell());
  return { user, panel: await screen.findByRole("dialog", { name: "Notifications" }) };
}

beforeEach(() => {
  signInAs();
  try { window.localStorage.removeItem("db.bell.enabled.1"); } catch { /* none */ }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<NotificationBell> — when it shows", () => {
  it("shows nothing while the store has the bell off", async () => {
    const calls = mockFetch({ [BELL]: { body: answer([], { enabled: false }) } });
    show();
    await waitFor(() => expect(callsTo(calls, BELL)).toHaveLength(1));
    expect(screen.queryByTestId("notification-bell")).toBeNull();
  });

  it("a failed first load leaves the page alone (no bell, no error)", async () => {
    const calls = mockFetch({ [BELL]: { status: 500, body: { detail: "boom" } } });
    show();
    await waitFor(() => expect(callsTo(calls, BELL).length).toBeGreaterThan(0));
    expect(screen.queryByTestId("notification-bell")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes its place on first paint when it was on last time", async () => {
    window.localStorage.setItem("db.bell.enabled.1", "1");
    mockFetch({ [BELL]: { status: 500, body: { detail: "boom" } } });
    show();
    expect(screen.getByTestId("notification-bell")).toBeInTheDocument();
    const { panel } = await openPanel();
    expect(await within(panel).findByText("Couldn't load your notifications."))
      .toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("remembers that it was off so the next paint shows nothing", async () => {
    window.localStorage.setItem("db.bell.enabled.1", "1");
    mockFetch({ [BELL]: { body: answer([], { enabled: false }) } });
    show();
    await waitFor(() => expect(screen.queryByTestId("notification-bell")).toBeNull());
    expect(window.localStorage.getItem("db.bell.enabled.1")).toBeNull();
  });
});

describe("<NotificationBell> — the button never changes size", () => {
  it("has no badge at 0 and says so in its label", async () => {
    mockFetch({ [BELL]: { body: answer([]) } });
    show();
    const btn = await bell();
    await waitFor(() => expect(btn).toHaveAccessibleName("Notifications, none"));
    expect(within(btn).queryByTestId("count-badge")).toBeNull();
  });

  it("counts the items and caps the badge at 9+", async () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ ...BANK, key: `bank.to_check:${n}` }));
    mockFetch({ [BELL]: { body: answer(many) } });
    show();
    const btn = await bell();
    await waitFor(() => expect(within(btn).getByTestId("count-badge")).toHaveTextContent("9+"));
    expect(btn).toHaveAccessibleName("Notifications, 12 need attention");
  });

  it("the same class at 0 and at 3: size lives in CSS, not in the count", async () => {
    mockFetch({ [BELL]: { body: answer([]) } });
    const first = show();
    const empty = (await bell()).className;
    first.unmount();
    vi.unstubAllGlobals();
    mockFetch({ [BELL]: { body: answer([UNLOCKED, BANK, CHECKS]) } });
    show();
    const btn = await bell();
    await waitFor(() => expect(within(btn).getByTestId("count-badge")).toHaveTextContent("3"));
    expect(btn.className).toBe(empty);
  });

  it("the CSS fixes the button's box and draws the badge on top", () => {
    const css = bellCss;
    const rule = css.slice(css.indexOf(".bellBtn {"), css.indexOf("}", css.indexOf(".bellBtn {")));
    expect(rule).toMatch(/width:\s*2\.25rem/);
    expect(rule).toMatch(/height:\s*2\.25rem/);
    expect(rule).toMatch(/flex:\s*0 0 2\.25rem/);
    expect(rule).toMatch(/position:\s*relative/);
    const badge = badgeCss;
    const pinned = badge.slice(badge.indexOf(".pinned {"), badge.indexOf("}", badge.indexOf(".pinned {")));
    expect(pinned).toMatch(/position:\s*absolute/);
  });
});

describe("<NotificationBell> — the list", () => {
  it("says what is wrong and links to the page that fixes it", async () => {
    mockFetch({ [BELL]: { body: answer([DUE_BACK, CHECKS, UNLOCKED, BANK]) } });
    show();
    const { panel } = await openPanel();
    const links = await within(panel).findAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `/daily/edit?date=${STORE_DAY}`,
      "/return-checks?status=pending",
      "/daily/edit?date=2026-11-03",
      "/bank-transactions",
    ]);
    expect(within(panel).getByText("Money is past its back-by date")).toBeInTheDocument();
    expect(within(panel).getByText(/2 entries · \$750\.00 · since Sun, Nov 1, 2026/))
      .toBeInTheDocument();
    expect(within(panel).getByText("A daily book is not locked")).toBeInTheDocument();
    expect(within(panel).getByText("Yesterday")).toBeInTheDocument();
    expect(within(panel).getByText("4 bank transactions to check")).toBeInTheDocument();
    expect(within(panel).getByText("1 returned check pending over 30 days"))
      .toBeInTheDocument();
    expect(within(panel).getByText(/come back tomorrow/)).toBeInTheDocument();
  });

  it("opening a row closes the panel and goes there", async () => {
    mockFetch({ [BELL]: { body: answer([BANK]) } });
    show();
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole("link"));
    expect(await screen.findByText("Navigated to /bank-transactions")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Notifications" })).toBeNull();
  });

  it("all caught up when there is nothing to do", async () => {
    mockFetch({ [BELL]: { body: answer([]) } });
    show();
    const { panel } = await openPanel();
    expect(await within(panel).findByText("You're all caught up.")).toBeInTheDocument();
    expect(within(panel).queryAllByRole("link")).toHaveLength(0);
  });

  it("never shows an item whose page the person cannot open", async () => {
    signInAs({ without: ["bank_sync.read"] });
    mockFetch({ [BELL]: { body: answer([UNLOCKED, BANK]) } });
    show();
    const btn = await bell();
    await waitFor(() => expect(btn).toHaveAccessibleName("Notifications, 1 needs attention"));
    const { panel } = await openPanel();
    expect(within(panel).queryByText(/bank transactions/)).toBeNull();
    expect(within(panel).getByText("A daily book is not locked")).toBeInTheDocument();
  });

  it("Escape closes the panel and gives focus back to the bell", async () => {
    mockFetch({ [BELL]: { body: answer([UNLOCKED]) } });
    show();
    const { user } = await openPanel();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await bell()).toHaveFocus();
  });
});

describe("<NotificationBell> — dismiss", () => {
  it("dismisses for today, then Undo brings it back", async () => {
    let items = [UNLOCKED, BANK];
    const calls = mockFetch({
      [BELL]: () => ({ body: answer(items) }),
      [DISMISS]: (req) => {
        const key = (req.body as { key: string }).key;
        items = items.filter((i) => i.key !== key);
        return { body: { ok: true } };
      },
      [UNDISMISS]: () => {
        items = [UNLOCKED, BANK];
        return { body: { ok: true } };
      },
    });
    show();
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole("button", {
      name: "Dismiss for today: A daily book is not locked",
    }));
    expect(callsTo(calls, DISMISS)[0].body).toEqual({ key: "daily_book.unlocked" });
    await waitFor(() => expect(within(panel).queryByText("A daily book is not locked")).toBeNull());
    expect(await bell()).toHaveAccessibleName("Notifications, 1 needs attention");
    expect(await screen.findByText("Dismissed for today.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(callsTo(calls, UNDISMISS)[0].body).toEqual({ key: "daily_book.unlocked" });
    // The toast sits outside the panel, so pressing it closes the
    // panel; the bell's count shows the item is back.
    await waitFor(async () => expect(await bell())
      .toHaveAccessibleName("Notifications, 2 need attention"));
  });

  it("a refused dismiss puts the row back and says why", async () => {
    mockFetch({
      [BELL]: { body: answer([UNLOCKED]) },
      [DISMISS]: { status: 403, body: { detail: "Only the person can dismiss their own reminders." } },
    });
    show();
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole("button", { name: /Dismiss for today/ }));
    expect(await screen.findByText("Only the person can dismiss their own reminders."))
      .toBeInTheDocument();
    expect(within(panel).getByText("A daily book is not locked")).toBeInTheDocument();
  });

  it("no Dismiss buttons while a superadmin is signed in as the person", async () => {
    mockFetch({ [BELL]: { body: answer([UNLOCKED, BANK], { can_dismiss: false }) } });
    show();
    const { panel } = await openPanel();
    await within(panel).findAllByRole("link");
    expect(within(panel).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });
});

describe("<NotificationBell> — Spanish", () => {
  it("shows the bell, its list and its buttons in Spanish", async () => {
    const { setLanguage } = await import("../i18n");
    const { englishLeftovers } = await import("../test/i18n");
    setLanguage("es");
    mockFetch({ [BELL]: { body: answer([UNLOCKED, DUE_BACK, BANK, CHECKS]) } });
    show();
    const btn = await bell();
    await waitFor(() => expect(btn).toHaveAccessibleName("Notificaciones, 4 requieren atención"));
    await userEvent.setup().click(btn);
    const panel = await screen.findByRole("dialog", { name: "Notificaciones" });
    expect(within(panel).getByText("Un libro diario no está cerrado")).toBeInTheDocument();
    expect(within(panel).getByText("Ayer")).toBeInTheDocument();
    expect(within(panel).getByText("4 movimientos bancarios por revisar")).toBeInTheDocument();
    // The panel and the button (the toast host's own region label is
    // the kit's, not the bell's).
    expect(englishLeftovers(panel, ["bell.", "shell.notifications"])).toEqual([]);
    expect(englishLeftovers(btn, ["bell.", "shell.notifications"])).toEqual([]);
  });
});

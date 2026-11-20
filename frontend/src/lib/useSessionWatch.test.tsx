import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_STATUS_KEY } from "../api/account";
import {
  SESSION_CHECK_EVERY_MS, SESSION_CHECK_MIN_GAP_MS, useSessionWatch,
} from "./useSessionWatch";

// An open tab re-checks its session (owner, 2026-11-20: an ended
// session goes to the sign-in page for every role): every few minutes
// while the tab is in view, and when the person comes back to it — at
// most every 30 seconds — and never while the tab is hidden. The
// check is the session-status query; `api()` turns its 401 into the
// sign-in page (lib/api.test.ts).

let checks = 0;
let visibility: DocumentVisibilityState = "visible";

function Shell() {
  useQuery({
    queryKey: SESSION_STATUS_KEY,
    queryFn: async () => { checks += 1; return { ok: true }; },
  });
  useSessionWatch();
  return null;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Shell />
    </QueryClientProvider>,
  );
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  checks = 0;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true, get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSessionWatch", () => {
  it("re-checks the session every few minutes while the tab is in view", async () => {
    mount();
    await flush();
    expect(checks).toBe(1); // the shell's own first load
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_EVERY_MS);
    expect(checks).toBe(2);
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_EVERY_MS);
    expect(checks).toBe(3);
  });

  it("checks when the person comes back to the tab, at most every 30 seconds", async () => {
    mount();
    await flush();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_MIN_GAP_MS + 1);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(checks).toBe(2);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(checks).toBe(2); // too soon after the last check
  });

  it("does not check while the tab is hidden", async () => {
    mount();
    await flush();
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_EVERY_MS * 3);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(checks).toBe(1);
  });

  it("stops checking once the shell is gone", async () => {
    const { unmount } = mount();
    await flush();
    unmount();
    await vi.advanceTimersByTimeAsync(SESSION_CHECK_EVERY_MS * 2);
    expect(checks).toBe(1);
  });
});

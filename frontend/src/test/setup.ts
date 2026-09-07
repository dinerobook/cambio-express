// Test setup — loaded once before any test file runs.
//
// Adds @testing-library/jest-dom matchers (`toBeInTheDocument`,
// `toHaveTextContent`, etc.) to Vitest's `expect`.
//
// Also wires the React Testing Library auto-cleanup hook —
// RTL skips its own afterEach registration when Vitest is
// configured with `globals: false`, so we register it manually
// here.  Without this, components leak between tests and
// `screen.getByRole(...)` returns "multiple elements found"
// errors that look like real bugs.

import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Every link, tab, button and row action hides itself when the
// signed-in person cannot use it (lib/access.ts — "no access, no
// control"). Tests that render a component in isolation therefore
// need SOMEONE signed in, or every control vanishes and the test
// reads like a rendering bug. Seed a store admin who holds every
// permission; a test about a narrower role overwrites this in its
// own beforeEach (see routes/Settings.test.tsx).
const RESOURCES = [
  "transfers", "customers", "daily_book", "monthly", "batches",
  "bank_sync", "reports", "settings", "users", "time_clock",
  "return_checks", "lottery", "day_close", "catalog",
];
const ACTIONS = ["create", "read", "update", "delete"];
export const TEST_ADMIN = {
  user_id: 1, username: "admin@test", full_name: "Test Admin",
  role: "admin", store_id: 1,
  permissions: RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}.${a}`)),
};

beforeEach(() => {
  try {
    window.localStorage.setItem("db.identity", JSON.stringify(TEST_ADMIN));
  } catch {
    /* no storage in this environment */
  }
});

// jsdom has no ResizeObserver; Radix's popper positioning
// (Tooltip) observes the trigger for size changes. A no-op stub
// is enough — tests assert presence/content, not pixel position.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

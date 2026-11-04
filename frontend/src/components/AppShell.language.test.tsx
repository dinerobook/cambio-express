import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "./AppShell";
import { getLanguage, setLanguage } from "../i18n";
import { mockFetch } from "../test/fetchMock";
import { ToastProvider } from "./ui/Toast";

// The shell applies the person's saved language once the profile
// loads (UI-STANDARDS §10): a saved choice wins over the device, a
// profile that never chose keeps the device's language.

const useProfile = vi.fn();

vi.mock("../api/account", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/account")>();
  return {
    ...real,
    useProfile: () => useProfile(),
    useSessionStatus: () => ({ data: undefined }),
    useStoreInfo: () => ({ data: undefined }),
  };
});
vi.mock("../api/support", () => ({
  useTicketsUnread: () => ({ data: { unread: 0 } }),
}));

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        {/* The app mounts the shell inside ToastProvider (App.tsx);
            the bell in the top bar needs it. */}
        <ToastProvider>
          <AppShell><p>page</p></AppShell>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no matchMedia; the install button asks it.
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }) as never;
  mockFetch({
    "GET /api/v2/maintenance-status": { body: { enabled: false, message: "" } },
    "GET /api/v2/*": { body: {} },
  });
});

describe("AppShell language", () => {
  it("switches to the profile's saved Spanish", async () => {
    useProfile.mockReturnValue({ data: { language: "es", theme_preference: "dark" } });
    renderShell();
    await waitFor(() => expect(getLanguage()).toBe("es"));
    expect(screen.getByRole("button", { name: "Abrir navegación" })).toBeInTheDocument();
  });

  it("a saved English wins over a device left on Spanish", async () => {
    setLanguage("es");
    useProfile.mockReturnValue({ data: { language: "en", theme_preference: "dark" } });
    renderShell();
    await waitFor(() => expect(getLanguage()).toBe("en"));
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  it("never chosen keeps the device's language", () => {
    setLanguage("es");
    useProfile.mockReturnValue({ data: { language: null, theme_preference: "dark" } });
    renderShell();
    expect(getLanguage()).toBe("es");
  });

  it("an older server with no language field changes nothing", () => {
    useProfile.mockReturnValue({ data: { theme_preference: "dark" } });
    renderShell();
    expect(getLanguage()).toBe("en");
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });
});

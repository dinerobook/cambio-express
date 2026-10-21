// Render a route the way the app shell does: a fresh QueryClient (no
// retries, so a failed load shows its error state at once), the toast
// host, and a MemoryRouter positioned at `at` with the element mounted
// on `path` (so `useParams` sees the URL's params). Any navigation
// away lands on a route that prints "Navigated to <path>".
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes,
} from "react-router-dom";

import { UnsavedChangesHost } from "../components/UnsavedChangesHost";
import { ToastProvider } from "../components/ui/Toast";
import { setCurrentIdentity, type IdentityClaims } from "../lib/auth";
import { Elsewhere } from "./Elsewhere";
import { TEST_ADMIN } from "./setup";

export function renderRoute(
  element: ReactElement,
  { path = "/", at = path }: { path?: string; at?: string } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route path={path} element={element} />
            <Route path="*" element={<Elsewhere />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Sign in as the test admin with some fields changed, or some
 *  rights taken away (`without`). */
export function signInAs(
  overrides: Partial<IdentityClaims> & { without?: string[] } = {},
): void {
  const { without = [], ...rest } = overrides;
  setCurrentIdentity({
    ...TEST_ADMIN,
    ...rest,
    permissions: (rest.permissions ?? TEST_ADMIN.permissions).filter(
      (p) => !without.includes(p),
    ),
  });
}

/** Like renderRoute, but on a data router with the app's
 *  <UnsavedChangesHost>, the way main.tsx + App mount pages — so a
 *  test can leave the page (`router.navigate("/elsewhere")`, the
 *  sidebar's path) and see the unsaved-changes prompt. */
export function renderRouteWithGuard(
  element: ReactElement,
  { path = "/", at = path, from }: {
    path?: string; at?: string;
    /** A page in history before `at`, so the back button has somewhere to go. */
    from?: string;
  } = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(
    [{
      path: "*",
      element: (
        <>
          <Routes>
            <Route path={path} element={element} />
            <Route path="*" element={<Elsewhere />} />
          </Routes>
          <UnsavedChangesHost />
        </>
      ),
    }],
    { initialEntries: from ? [from, at] : [at] },
  );
  const result = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...result, router };
}

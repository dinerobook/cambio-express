// Impersonation: a superadmin signed in AS a customer's login.
//
// Both superadmin pages that offer "Sign in as" (the Users list and
// the store page's team list) go through `startImpersonation`, and
// the shell's banner ends it through `stopImpersonation`. The server
// does the real work — it swaps the httpOnly access cookie for the
// customer's token on start and drops it on stop — so the SPA only
// has to refresh its identity cache and move to the right page.
//
// Why a full-page navigation (`window.location.assign`) rather than
// the router: every query cache, nav gate and identity read in the
// shell was built for the superadmin; a reload rebuilds all of it
// for the customer in one step instead of chasing stale state.

import { impersonateUser, stopImpersonationRequest } from "../api/superadmin";
import { clearAccessToken, refreshToken, setAccessToken } from "./auth";

/** Where the superadmin lands after stepping back out. */
export const IMPERSONATION_RETURN_PATH = "/app/superadmin/users";

export async function startImpersonation(userId: number): Promise<void> {
  const res = await impersonateUser(userId);
  // The cookie was set by the server; this caches the non-secret
  // claims (role, store, permissions) so the chrome renders the
  // customer's nav on first paint.
  setAccessToken(res.token);
  window.location.assign("/app/dashboard");
}

/**
 * End the impersonation and bring the superadmin's own session
 * back. The superadmin's refresh cookie was never touched, so one
 * `/auth/refresh` re-mints their access cookie; if that refresh
 * has expired in the meantime the login page is the honest
 * destination.
 */
export async function stopImpersonation(): Promise<void> {
  try {
    await stopImpersonationRequest();
  } catch {
    /* The access cookie may already have expired (one-hour TTL);
       the refresh below still restores the superadmin. */
  }
  clearAccessToken();
  const restored = await refreshToken();
  window.location.assign(restored ? IMPERSONATION_RETURN_PATH : "/app/login");
}

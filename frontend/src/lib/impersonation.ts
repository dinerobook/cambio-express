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

import {
  impersonateUser, stopImpersonationRequest, type ImpersonationMode,
} from "../api/superadmin";
import { clearAccessToken, refreshToken, setAccessToken } from "./auth";

/** Where the superadmin lands after stepping back out. */
export const IMPERSONATION_RETURN_PATH = "/app/superadmin/users";

/** The server's reason code on the 403 a read-only session gets
 *  for any write; `api()` already surfaces the message as the
 *  thrown error's text, so pages need no special handling. */
export const READ_ONLY_REASON = "read_only_impersonation";

/**
 * `mode` "full" acts as the person; "read_only" only looks (every
 * write is refused server-side, so a support agent can walk through
 * a customer's books without the risk of changing them).
 */
export async function startImpersonation(
  userId: number, mode: ImpersonationMode = "full",
): Promise<void> {
  const res = await impersonateUser(userId, mode);
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

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { SESSION_STATUS_KEY } from "../api/account";

// An open tab notices when its session has ended (owner, 2026-11-20:
// "session expire per login k page per bhej do", for every role).
//
// A page that is only being looked at makes no API calls, so the 401
// that sends a dead session to the sign-in page (`api()` → refresh →
// `/app/login?expired=1`) never came: the tab kept showing the app
// after the session was gone. The shell now re-runs the session check
// every few minutes while the tab is in view, and as soon as the
// person comes back to the tab. A live session just refreshes its
// details (permissions, store); a dead one goes to the sign-in page.
//
// Checking does not keep a session alive: the refresh chain has a
// fixed end (14 days, 7 for support — `reuse()` never extends it), so
// an idle tab still signs out on time.

/** How often a tab in view re-checks its session. */
export const SESSION_CHECK_EVERY_MS = 2 * 60 * 1000;
/** Coming back to the tab checks at most this often. */
export const SESSION_CHECK_MIN_GAP_MS = 30 * 1000;

export function useSessionWatch(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let last = Date.now();
    const check = (force: boolean) => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (!force && now - last < SESSION_CHECK_MIN_GAP_MS) return;
      last = now;
      void queryClient.refetchQueries({ queryKey: SESSION_STATUS_KEY, type: "active" });
    };
    const onBack = () => check(false);
    const timer = window.setInterval(() => check(true), SESSION_CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onBack);
    window.addEventListener("focus", onBack);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onBack);
      window.removeEventListener("focus", onBack);
    };
  }, [queryClient]);
}

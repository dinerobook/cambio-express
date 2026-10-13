import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { logout } from "./auth";
import { clearVisits } from "./recency";

/** The one way to sign out from inside the app.
 *
 *  - `logout()` asks the server to revoke the refresh session and
 *    drop the cookies, and clears the identity hint, the PWA refresh
 *    fallback and an owner's remembered store on this device. Only
 *    clearing the identity hint left the refresh session alive: the
 *    next visit refreshed straight back in.
 *  - The React Query cache holds the last person's data (transfers,
 *    customers, the books); the next person on a shared counter
 *    browser must not see it while their own pages load.
 *  - "Most Used" tiles are the previous cashier's habits.
 *
 *  It always lands on /login, even when the server can't be
 *  reached: a sign-out that strands the person in the app is worse
 *  than one whose server half is finished by the next 401. */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      clearVisits();
      await logout();
    } catch {
      /* the local half is done; never strand the person here */
    } finally {
      navigate("/login", { replace: true });
      queryClient.clear();
    }
  }, [navigate, queryClient]);
}

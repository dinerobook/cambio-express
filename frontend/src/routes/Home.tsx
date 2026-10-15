import { useEffect } from "react";
import { Navigate } from "react-router-dom";

import { getCurrentIdentity } from "../lib/auth";
import Login from "./Login";

// Site root (/app/). Most people who open the site are coming to
// sign in, so a signed-out visitor gets the sign-in page (with the
// features panel beside the form) rather than the marketing page,
// which lives at /features. A visitor who is already signed in goes
// straight to the dashboard; if their session has lapsed,
// RequireAuth there sends them back to sign in.
export default function Home() {
  // The root used to be the marketing page, which registered the
  // service worker for first-time visitors; keep doing that here.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  if (getCurrentIdentity()) return <Navigate to="/dashboard" replace />;
  return <Login />;
}

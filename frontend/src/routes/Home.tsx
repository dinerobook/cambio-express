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
  if (getCurrentIdentity()) return <Navigate to="/dashboard" replace />;
  return <Login />;
}

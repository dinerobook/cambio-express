import { Navigate, useSearchParams } from "react-router-dom";

// The Period P&L lives on the Monthly P&L page now, as a date range
// (owner, 2026-11-27 — Monthly INVARIANTS "Any date range"). Old
// links and bookmarks, the store's and the owner's, open it there
// with the same days.
export default function PeriodPLRedirect() {
  const [sp] = useSearchParams();
  const from = sp.get("from");
  const to = sp.get("to");
  const target = from && to
    ? `/monthly?${new URLSearchParams({ from, to }).toString()}`
    : "/monthly";
  return <Navigate to={target} replace />;
}

import { useLocation } from "react-router-dom";

/** Catch-all route for route tests: prints where a navigation landed. */
export function Elsewhere() {
  const { pathname } = useLocation();
  return <p>Navigated to {pathname}</p>;
}

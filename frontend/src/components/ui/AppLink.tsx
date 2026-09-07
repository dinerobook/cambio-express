import { Link, type LinkProps } from "react-router-dom";

import { canAccess } from "../../lib/access";

/** In-app link that disappears when the person cannot open its
 *  target (`lib/access.ts`). Use instead of React Router's `Link`
 *  for anything rendered inside the authed shell.
 *
 *  `fallback="text"` renders the children as plain text instead of
 *  nothing — for links inside a sentence, where a hole would read
 *  wrong ("Open the ___ to continue"). Default hides the link. */
export function AppLink({
  to, fallback = "hide", children, ...rest
}: LinkProps & { to: string; fallback?: "hide" | "text" }) {
  if (!canAccess(to)) {
    return fallback === "text" ? <>{children}</> : null;
  }
  return <Link to={to} {...rest}>{children}</Link>;
}

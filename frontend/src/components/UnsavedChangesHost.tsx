import { useCallback, useContext } from "react";
import {
  UNSAFE_DataRouterContext, useBlocker, type BlockerFunction,
} from "react-router-dom";

import { ConfirmDialog } from "./ui";
import { activeUnsavedMessage } from "../lib/useUnsavedGuard";
import { useT } from "../i18n";

// The single router blocker behind every unsaved-changes guard
// (see lib/useUnsavedGuard.ts). Rendered once in App: while any form
// on screen is dirty, an in-app navigation (sidebar, breadcrumb,
// back button, `navigate()`) is held and confirmed with the same
// "Leave without saving?" prompt the forms' own Cancel buttons use.
//
// `useBlocker` needs a data router (main.tsx's createBrowserRouter).
// Component tests mount pages under a plain <MemoryRouter>; there the
// host renders nothing instead of throwing.
export function UnsavedChangesHost() {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <LeaveBlocker /> : null;
}

function LeaveBlocker() {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      activeUnsavedMessage() !== null
      // Only leaving the page loses the form. A query-string change on
      // the same page (a tab, a list's filters or page) keeps it
      // mounted; a page whose query names WHAT is edited (the daily
      // book's ?date=) steps through the guard's confirmLeave.
      && currentLocation.pathname !== nextLocation.pathname,
    [],
  );
  const blocker = useBlocker(shouldBlock);
  const t = useT();
  const blocked = blocker.state === "blocked";
  return (
    <ConfirmDialog
      open={blocked}
      title={t("unsaved.title")}
      message={(blocked && activeUnsavedMessage()) || ""}
      confirmLabel={t("unsaved.leave")}
      cancelLabel={t("unsaved.keepEditing")}
      confirmTone="danger"
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  );
}

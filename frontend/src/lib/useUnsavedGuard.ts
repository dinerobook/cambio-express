import { useCallback, useEffect, useId, useState } from "react";

// The one unsaved-changes guard for every edit form in the SPA.
//
// A form computes its own `dirty` flag (the draft differs from the
// last-saved values — `useDirtyBaseline` below does that for plain
// useState forms, react-hook-form has `formState.isDirty`) and hands
// it here. While dirty, three layers protect the edits:
//
//   1. Refresh / tab close / typed URL — the browser's native
//      "Leave site? Changes you made may not be saved." prompt via
//      `beforeunload`.
//   2. Any in-app navigation — sidebar link, breadcrumb, back
//      button, a `navigate()` call — is held by the router blocker
//      in <UnsavedChangesHost> (rendered once in App) and confirmed
//      with "Leave without saving?". The host reads the registry
//      below, so a page with two guarded forms still gets one prompt.
//   3. The form's own Cancel / Back control — `confirmLeave(fn)`
//      shows the same prompt (rendered by <FormActions guard>) and
//      runs `fn` only on "Leave". It also covers leaves that are not
//      a route change (closing a panel, stepping a date in place).
//
// After a successful save, navigate with `guard.proceed(fn)` so the
// save itself is never questioned, even if the draft has not been
// re-baselined yet when the navigation fires.
//
// Usage:
//   const guard = useUnsavedGuard(isDirty && !busy, {
//     message: "You have unsaved edits on this batch. Leave without saving?",
//   });
//   <FormActions guard={guard}>
//     <Button onClick={() => guard.confirmLeave(() => navigate("/x"))}>Cancel</Button>
//     <Button type="submit">Save</Button>
//   </FormActions>

export const DEFAULT_UNSAVED_TITLE = "Discard unsaved changes?";
export const DEFAULT_UNSAVED_MESSAGE =
  "You have unsaved edits on this page. Leave without saving?";

// ── Registry read by <UnsavedChangesHost> ───────────────────────────

const dirtyGuards = new Map<string, string>();
let skipDepth = 0;

/** The message of the most recently dirtied form, or null when every
 *  form on screen is clean (or a save is navigating away). */
export function activeUnsavedMessage(): string | null {
  if (skipDepth > 0 || dirtyGuards.size === 0) return null;
  return Array.from(dirtyGuards.values()).pop() ?? null;
}

/** Run `fn` (a navigation) without any unsaved-changes prompt. The
 *  router checks blockers synchronously inside `navigate()`, so the
 *  skip only needs to last for the call. */
export function withoutUnsavedPrompt(fn: () => void): void {
  skipDepth += 1;
  try {
    fn();
  } finally {
    skipDepth -= 1;
  }
}

// ── The hook ─────────────────────────────────────────────────────────

export interface UnsavedGuardDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmTone: "danger";
  onConfirm: () => void;
  onCancel: () => void;
}

export interface UnsavedGuard {
  /** True while there are edits that would be lost. */
  dirty: boolean;
  /** Run `proceed` immediately when the form is clean; otherwise ask
   *  first and run it only if the person chooses Leave. */
  confirmLeave: (proceed: () => void) => void;
  /** Run `fn` with no prompt — the navigation after a save. */
  proceed: (fn: () => void) => void;
  /** Props for the kit <ConfirmDialog>; <FormActions guard> renders it. */
  dialogProps: UnsavedGuardDialogProps;
}

export function useUnsavedGuard(
  dirty: boolean,
  opts: { title?: string; message?: string } = {},
): UnsavedGuard {
  const title = opts.title ?? DEFAULT_UNSAVED_TITLE;
  const message = opts.message ?? DEFAULT_UNSAVED_MESSAGE;
  const id = useId();

  // Layer 1: browser-native prompt on refresh / close.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      // Both are needed across browsers to trigger the native prompt.
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Layer 2: register with the router blocker host.
  useEffect(() => {
    if (!dirty) return;
    dirtyGuards.set(id, message);
    return () => { dirtyGuards.delete(id); };
  }, [dirty, id, message]);

  // Layer 3: the form's own leave controls. `pending` holds the
  // deferred action; storing a function in state needs the object
  // wrapper so React doesn't call it as an updater.
  const [pending, setPending] = useState<{ proceed: () => void } | null>(null);

  const confirmLeave = useCallback(
    (proceed: () => void) => {
      if (dirty) setPending({ proceed });
      else withoutUnsavedPrompt(proceed);
    },
    [dirty],
  );

  return {
    dirty,
    confirmLeave,
    proceed: withoutUnsavedPrompt,
    dialogProps: {
      open: pending !== null,
      title,
      message,
      confirmLabel: "Leave",
      cancelLabel: "Keep editing",
      confirmTone: "danger",
      onConfirm: () => {
        const action = pending?.proceed;
        setPending(null);
        if (action) withoutUnsavedPrompt(action);
      },
      onCancel: () => setPending(null),
    },
  };
}

// ── Dirty tracking for plain useState forms ─────────────────────────

/** Compares a form's current values with the values it had when it
 *  became `ready` (loaded). Returns `dirty` and `markSaved()`, which
 *  takes the current values as the new baseline after a save.
 *
 *  `ready` must turn true only once the editable state holds the
 *  loaded values (a form hydrated in an effect passes a `hydrated`
 *  flag set in that same effect), otherwise the empty pre-hydrate
 *  values become the baseline and the form reads dirty on load. */
export function useDirtyBaseline(
  current: unknown,
  ready = true,
): { dirty: boolean; markSaved: () => void } {
  const snapshot = JSON.stringify(current);
  const [baseline, setBaseline] = useState<string | null>(
    ready ? snapshot : null,
  );
  // Adjust-state-during-render: capture the baseline the first render
  // `ready` is true (and again after markSaved cleared it).
  if (ready && baseline === null) setBaseline(snapshot);
  const markSaved = useCallback(() => setBaseline(null), []);
  return { dirty: baseline !== null && snapshot !== baseline, markSaved };
}

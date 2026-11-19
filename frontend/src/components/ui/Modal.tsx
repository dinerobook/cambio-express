import { useT } from "../../i18n";
import { isValidElement, type CSSProperties, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

import { Alert } from "./Alert";
import { Button, type ButtonTone } from "./Button";

import styles from "./Modal.module.css";

/** Kit modal primitive — Radix Dialog under the hood, same API.
 *
 *  Replaces the hand-rolled `.modalBackdrop` + `.modalCard`
 *  blocks scattered across Customers / AdminTimeClock / TVDisplay
 *  and the bare `window.confirm()` / `window.alert()` calls in
 *  the rest of the SPA.  Radix supplies the hard parts we used to
 *  hand-roll (and the one we never had):
 *
 *  - Portal to body so `position: fixed` pins to the viewport
 *    (a `.ds-page` entry animation otherwise establishes a
 *    containing block and traps the modal inside the page flow).
 *  - `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
 *    wired to the title for screen readers.
 *  - A REAL focus trap: Tab / Shift-Tab cycle inside the dialog
 *    instead of escaping into the page behind it. Focus lands in
 *    the card on open and returns to the trigger on close.
 *  - Escape-key + click-outside dismissal (both gated by
 *    `disabled` so a busy save doesn't get torn out).
 *  - Body-scroll lock while open.
 *  - Reduced-motion: the global `@media (prefers-reduced-motion:
 *    reduce)` rule in `src/styles.css` strips the fade-scale
 *    keyframes for users who asked for it.
 *
 *  The Content nests inside the Overlay (the Radix "scrollable
 *  overlay" pattern) so the existing flex-centering CSS keeps
 *  working unchanged.
 *
 *  When `open` is false the component renders nothing. */
/** The Cancel / Save row at the bottom of a modal. `Modal`'s
 *  `actions` prop renders it for you; a modal whose body is a
 *  `<form>` (the submit button must sit inside the form) puts this
 *  as the form's last child instead. One row everywhere: buttons on
 *  the right, primary last, wrapping on a narrow phone. */
export function ModalActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

export function Modal({
  open, onClose, title, children, actions, size = "md",
  closeOnBackdrop = true, closeOnEscape = true, disabled = false,
}: {
  open: boolean;
  /** Called when the user dismisses via Escape / backdrop click.
   *  Wrap your own close-button handler in this too. */
  onClose: () => void;
  /** Heading text — a ReactNode so callers can append an
   *  `<InfoTip>` per the contextual-help standard. */
  title: ReactNode;
  children: ReactNode;
  /** Optional row of buttons rendered in a flex-end strip below
   *  the body.  Use `<Button>` from the kit so the focus ring +
   *  busy state come for free.  Pass null when the body itself
   *  is a form with its own submit row. */
  actions?: ReactNode;
  /** `sm` (24rem) for confirm dialogs, `md` (32rem) for short
   *  forms, `lg` (48rem) for long forms / tables / wizards, `xl`
   *  (64rem) for a wide grid of inputs (the daily book's money
   *  transfer table: eight columns of amounts). */
  size?: "sm" | "md" | "lg" | "xl";
  /** Set false to keep the modal open when the user clicks the
   *  backdrop.  Default true. */
  closeOnBackdrop?: boolean;
  /** Set false to keep the modal open on Escape.  Default true. */
  closeOnEscape?: boolean;
  /** When true (e.g. mid-save), Escape + backdrop-click are
   *  suppressed so the user can't tear the modal out of a busy
   *  network round-trip. */
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !disabled) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.backdrop}>
          <Dialog.Content
            className={`${styles.card} ${sizeClass(size)}`}
            // The body is free-form content, not a single
            // description — suppress Radix's aria-describedby
            // wiring (and its dev warning) explicitly.
            aria-describedby={undefined}
            onOpenAutoFocus={(e) => {
              // Start on the first field, not the first focusable
              // thing: that was often a label's (i) button, whose tip
              // then opened over the very box you were about to type
              // in (Add an item). A date box is skipped: it opens its
              // calendar on focus, and the calendar then covered the
              // popup's buttons ("Change date"). No other field (a
              // confirm) → Radix's own pick, the first button; only a
              // date box → the card itself, so nothing pops open.
              // The ✕ sits in the header, first in the DOM, so with no
              // field the first button of the body or the button row
              // (a confirm's Cancel) is picked, never the ✕.
              const card = e.currentTarget as HTMLElement | null;
              const first = card?.querySelector<HTMLElement>(FIRST_FIELD);
              if (first) {
                e.preventDefault();
                first.focus();
              } else if (card?.querySelector(PICKER_FIELD)) {
                e.preventDefault();
                card.focus();
              } else {
                const button = card?.querySelector<HTMLElement>(
                  `.${styles.body} button:not(:disabled), .${styles.actions} button:not(:disabled)`,
                );
                if (button) {
                  e.preventDefault();
                  button.focus();
                }
              }
            }}
            onEscapeKeyDown={(e) => {
              if (!closeOnEscape || disabled) e.preventDefault();
            }}
            onPointerDownOutside={(e) => {
              if (!closeOnBackdrop || disabled) e.preventDefault();
            }}
            onInteractOutside={(e) => {
              if (!closeOnBackdrop || disabled) e.preventDefault();
            }}
          >
            {/* Three parts (UI-STANDARDS §2 "A popup's size"): the
                header (title + ✕) and the button row stay put, and only
                the body between them scrolls — with its own visible
                scrollbar, a line under the header once scrolled and a
                fade over the button row while more is below. Before,
                the whole card scrolled under a pinned button row: the
                last fields slid behind Save with nothing to say there
                was more ("Parent department" on Add a department). */}
            <div className={styles.header}>
              <Dialog.Title asChild>
                <h2 className={styles.title}>{title}</h2>
              </Dialog.Title>
              {/* A way out you can see (Escape and the backdrop were
                  the only ones). Named "Close window", not "Close", so
                  it never clashes with a popup's own Close button.
                  Disabled with the popup while a save runs. */}
              <Dialog.Close asChild>
                <button
                  type="button"
                  className={styles.close}
                  aria-label={t("modal.close")}
                  disabled={disabled}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="18" y1="6" x2="6" y2="18" />
                  </svg>
                </button>
              </Dialog.Close>
            </div>
            <div className={styles.body} ref={trackScroll}>{children}</div>
            {actions && (
              // A caller that already wrapped its buttons in
              // <ModalActions> gets one bar, not a bar inside a bar
              // (a second hairline and ~1rem of lost height).
              isValidElement(actions) && actions.type === ModalActions
                ? actions
                : <ModalActions>{actions}</ModalActions>
            )}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Marks the card while its body is scrolled (`data-scrolled`: a line
 *  under the header) and while more is below (`data-more`: a fade
 *  over the button row), so a popup taller than the window says it
 *  scrolls. A React 19 ref callback: the returned function detaches.
 *  Re-measured on scroll and whenever the body or what is in it
 *  changes size (a row added, an error shown). */
function trackScroll(body: HTMLDivElement | null) {
  if (!body) return;
  const card = body.parentElement;
  const update = () => {
    const scrolled = body.scrollTop > 1;
    const more = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
    card?.toggleAttribute("data-scrolled", scrolled);
    card?.toggleAttribute("data-more", more);
  };
  update();
  body.addEventListener("scroll", update, { passive: true });
  const resize = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(update);
  resize?.observe(body);
  const watch = () => {
    for (const child of Array.from(body.children)) resize?.observe(child);
    update();
  };
  watch();
  const mutations = typeof MutationObserver === "undefined"
    ? null
    : new MutationObserver(watch);
  mutations?.observe(body, { childList: true });
  return () => {
    body.removeEventListener("scroll", update);
    resize?.disconnect();
    mutations?.disconnect();
  };
}

/** The first control a person types into or picks from — not a box
 *  that opens a picker on focus (DateInput, aria-haspopup). */
const FIRST_FIELD = [
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([aria-haspopup]):not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
].join(", ");

const PICKER_FIELD = "input[aria-haspopup]:not(:disabled)";

function sizeClass(size: "sm" | "md" | "lg" | "xl"): string {
  if (size === "sm") return styles.sizeSm;
  if (size === "xl") return styles.sizeXl;
  if (size === "lg") return styles.sizeLg;
  return styles.sizeMd;
}


/** Confirm/Cancel dialog — the declarative replacement for
 *  `window.confirm(message)`.
 *
 *  Pattern at the call site:
 *
 *  ```tsx
 *  const [pending, setPending] = useState<Row | null>(null);
 *
 *  return (
 *    <>
 *      <Button onClick={() => setPending(row)}>Delete</Button>
 *      <ConfirmDialog
 *        open={pending != null}
 *        title="Delete row"
 *        message={`Delete "${pending?.name}"?`}
 *        confirmTone="danger"
 *        onConfirm={async () => {
 *          await api.delete(pending.id);
 *          setPending(null);
 *        }}
 *        onCancel={() => setPending(null)}
 *      />
 *    </>
 *  );
 *  ```
 *
 *  Keep the pending row in component state — it's what supplies
 *  the message + the action target.  When `pending` is null,
 *  `open` is false and the modal renders nothing. */
export function ConfirmDialog({
  open, title, message, onConfirm, onCancel, busy = false,
  confirmLabel, cancelLabel,
  confirmTone = "primary", error,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  /** Why the last confirm failed. Shown INSIDE the dialog: while
   *  it is open the page behind is covered and aria-hidden, so an
   *  error rendered there is one the person never sees. */
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  /** When true, both buttons disable + the primary shows the
   *  busy state.  Backdrop / Escape are also blocked so the
   *  user can't tear out a half-completed action. */
  busy?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use `danger` for destructive actions (delete, disconnect,
   *  revoke, deactivate).  Default `primary` for the typical
   *  Save/Confirm flow. */
  confirmTone?: Extract<ButtonTone, "primary" | "danger">;
}) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      disabled={busy}
      actions={
        <>
          <Button tone="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            tone={confirmTone}
            onClick={onConfirm}
            busy={busy}
            disabled={busy}
          >
            {confirmLabel ?? t("common.confirm")}
          </Button>
        </>
      }
    >
      {/* A plain sentence is a <p>; richer content (paragraphs, an
          info box) brings its own blocks, which may not sit inside a
          <p>. */}
      {typeof message === "string"
        ? <p style={messageStyle}>{message}</p>
        : <div style={messageStyle}>{message}</div>}
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

const messageStyle: CSSProperties = {
  margin: 0,
  lineHeight: 1.5,
};

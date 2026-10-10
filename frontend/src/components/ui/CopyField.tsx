import {
  useEffect, useId, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";

import { Button, type ButtonTone } from "./Button";
import { Input } from "./Input";
import { useToast } from "./Toast";
import { space, tokens } from "./tokens";

/** How long the button reads "Copied" before it goes back. */
const COPIED_MS = 1400;

/** Put `text` on the clipboard. Resolves `true` on success.
 *
 *  `navigator.clipboard` is missing on plain-http origins and some
 *  older in-app browsers, and it rejects when the page lacks
 *  clipboard permission — so on either we fall back to the legacy
 *  `execCommand("copy")` on a throwaway textarea. Only when BOTH
 *  fail do we report failure, and the caller tells the person to
 *  copy by hand rather than claiming success. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* permission denied / insecure context — try the fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** A button that copies `text` and says so: the label flips to
 *  "Copied" for a moment; a failure raises an error toast telling
 *  the person to copy by hand. Use on its own when the value is
 *  already on screen in some other form (the big referral code);
 *  otherwise reach for `<CopyField>`. */
export function CopyButton({
  text, label = "Copy", tone = "secondary", size, className,
  "aria-label": ariaLabel, onCopyFailed,
}: {
  text: string;
  label?: ReactNode;
  tone?: ButtonTone;
  size?: "sm" | "md" | "lg";
  className?: string;
  "aria-label"?: string;
  /** Runs after a failed copy, e.g. to select the text so a manual
   *  Ctrl+C works straight away. */
  onCopyFailed?: () => void;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A page can unmount mid-flash (navigating away right after a
  // copy); never set state on an unmounted button.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function onClick() {
    const ok = await copyText(text);
    if (!ok) {
      onCopyFailed?.();
      toast({
        message: "Couldn't copy. Select the text and copy it by hand.",
        tone: "error",
      });
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <Button
      tone={tone} size={size} className={className}
      aria-label={ariaLabel}
      onClick={() => { void onClick(); }}
    >
      {/* aria-live so a screen reader hears the confirmation that a
          sighted person sees as the label change. */}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}

/** Read-only value + Copy button — share links, invite codes,
 *  display URLs. One implementation so every copy affordance has
 *  the same fallback, feedback and failure handling.
 *
 *  - Focusing the field selects it, so a manual copy is one keystroke.
 *  - `variant="code"` shows a short code large, spaced and centred.
 *  - `actions` renders after the Copy button (an "Open ↗" link, a
 *    second copy of a related value).
 *  - The row wraps on narrow screens; the input may shrink
 *    (`min-width: 0`) so a long URL never pushes the buttons out of
 *    the card. */
export function CopyField({
  value, label, "aria-label": ariaLabel, copyLabel = "Copy",
  variant = "text", actions, buttonClassName, className,
}: {
  value: string;
  /** Visible label above the field. */
  label?: ReactNode;
  /** Accessible name for the input when there is no visible label. */
  "aria-label"?: string;
  copyLabel?: ReactNode;
  variant?: "text" | "code";
  actions?: ReactNode;
  buttonClassName?: string;
  className?: string;
}) {
  const id = useId();
  const inputStyle: CSSProperties = variant === "code"
    ? {
        fontFamily: tokens.fontMono,
        fontSize: "1.4rem",
        letterSpacing: "0.25em",
        fontWeight: 600,
        textAlign: "center",
      }
    // No inline font-size on the plain variant: the `.ds-input` rule
    // lifts it to 16px on phones so iOS doesn't zoom on focus, and an
    // inline size would override that.
    : { fontFamily: tokens.fontMono };

  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}
    >
      {label != null && (
        <label
          htmlFor={id}
          style={{ fontSize: "0.8rem", fontWeight: 600, color: tokens.text }}
        >
          {label}
        </label>
      )}
      <div
        style={{
          display: "flex", flexWrap: "wrap", alignItems: "center",
          gap: space.sm,
        }}
      >
        <Input
          id={id}
          type="text"
          readOnly
          value={value}
          aria-label={ariaLabel}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: "1 1 14rem", minWidth: 0, ...inputStyle }}
        />
        <CopyButton
          text={value}
          label={copyLabel}
          className={buttonClassName}
          onCopyFailed={() => {
            const el = document.getElementById(id);
            if (el instanceof HTMLInputElement) el.select();
          }}
        />
        {actions}
      </div>
    </div>
  );
}

import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker } from "react-day-picker";
import "react-day-picker/src/style.css";

import { toIsoDate } from "../../lib/datetime";
import { Input } from "./Input";
import styles from "./DateInput.module.css";

/**
 * Date input with a calendar popover. Drop-in replacement for
 * `<Input type="date" />` — same value format (YYYY-MM-DD string),
 * same onChange signature, but with a consistent cross-browser
 * calendar picker styled for the design system.
 *
 * Falls back to the raw input value for manual typing.
 *
 * The calendar renders in a Radix Popover portal, so it is never
 * clipped by a scrolling parent (a Modal body, a table cell) and
 * flips above the field when there is no room below. It used to be
 * an absolutely-positioned child: inside a Modal it was cut off and
 * its full-screen click-catcher swallowed the scroll wheel, leaving
 * the person stuck with no way to pick a date.
 */
export function DateInput({
  value,
  onChange,
  required,
  disabled,
  placeholder = "YYYY-MM-DD",
  ...rest
}: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const selected = value ? new Date(value + "T00:00:00") : undefined;

  function handleSelect(day: Date | undefined) {
    if (!day) return;
    onChange({ target: { value: toIsoDate(day) } });
    setOpen(false);
  }

  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className={styles.wrapper} ref={anchorRef}>
          <Input
            type="text"
            value={value}
            onChange={onChange}
            onFocus={() => !disabled && setOpen(true)}
            onClick={() => !disabled && setOpen(true)}
            placeholder={placeholder}
            required={required}
            disabled={disabled}
            readOnly={false}
            className={`${styles.trigger} ${rest.className ?? ""}`}
            style={rest.style}
            aria-label={rest["aria-label"]}
            aria-haspopup="dialog"
            aria-expanded={open}
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // Keep the caret in the text field so typing still works.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A click back on the field is not "outside".
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          <DayPicker
            mode="single"
            selected={selected}
            onSelect={handleSelect}
            defaultMonth={selected}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

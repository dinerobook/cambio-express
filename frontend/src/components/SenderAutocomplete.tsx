import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";

import { useCustomerSearch, type CustomerRow } from "../api/customers";
import { Input } from "./ui";
import styles from "./SenderAutocomplete.module.css";

// Type-and-pick autocomplete for the sender name on the transfer
// form. Wraps `useCustomerSearch` and a small popover.
//
//  • The visible <input> mirrors the form's sender_name field.
//  • Typing 2+ chars opens a dropdown with up to 8 matches +
//    suggestions from the umbrella's customer directory.
//  • Picking a row calls `onPick(row)` so the parent form can
//    fill phone country / phone / address / dob + remember the
//    customer_id (so the umbrella upsert reuses the same row
//    instead of creating a duplicate).
//  • Continuing to type without picking just updates
//    `sender_name`, the customer_id stays null, and the upsert
//    will fall back to phone-based lookup or create a new row.
//
// The list renders in a Radix Popover portal, the same way the shared
// date field's calendar does (#935). It used to be an absolutely
// positioned child of the field, so the next card on the form painted
// over it and the matches could not be clicked (owner report
// 2026-10-13). In the portal it sits above every card and any Modal,
// flips above the field when there is no room below, and is never
// clipped by a scrolling parent.

interface Props {
  value: string;
  onChange: (name: string) => void;
  onPick: (row: CustomerRow) => void;
  // Cleared to null when the user types a fresh value after a
  // pick so the upsert lookup falls back to phone-based dedupe
  // (matches legacy form behavior).
  onClearPickedId?: () => void;
  required?: boolean;
}

export default function SenderAutocomplete({
  value, onChange, onPick, onClearPickedId, required,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const anchorRef = useRef<HTMLDivElement>(null);
  const { data, isFetching } = useCustomerSearch(value);

  // Cap the dropdown so a noisy fuzzy result doesn't dominate
  // the form. 8 is a sweet spot per the legacy autocomplete UX.
  const matches     = (data?.matches ?? []).slice(0, 8);
  const suggestions = (data?.suggestions ?? []).slice(0, 8 - matches.length);
  const all = [...matches, ...suggestions];

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || all.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % all.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + all.length) % all.length);
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      pick(all[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActiveIdx(-1);
    }
  }

  function pick(row: CustomerRow) {
    onPick(row);
    setOpen(false);
    setActiveIdx(-1);
  }

  const showList = open && value.length >= 2;

  return (
    <Popover.Root
      open={showList}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setActiveIdx(-1);
      }}
    >
      <Popover.Anchor asChild>
        <div ref={anchorRef}>
          <Input
            type="text"
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              if (onClearPickedId) onClearPickedId();
              setOpen(true);
              setActiveIdx(-1);
            }}
            onFocus={() => setOpen(value.length >= 2)}
            onKeyDown={handleKey}
            autoComplete="off"
            required={required}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
          />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={`${styles.popover} ds-popover`}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          // The caret stays in the name field so typing keeps working.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          // A click back in the name field is not "outside".
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          <div role="listbox" aria-label="Existing customers">
            {isFetching && (
              <p className={styles.status}>Searching…</p>
            )}
            {!isFetching && all.length === 0 && (
              <p className={styles.status}>No matches.</p>
            )}
            {matches.length > 0 && (
              <SectionHeader>Matches</SectionHeader>
            )}
            {matches.map((row, i) => (
              <Row
                key={`m-${row.id}`}
                row={row}
                active={activeIdx === i}
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => pick(row)}
              />
            ))}
            {suggestions.length > 0 && (
              <SectionHeader>Suggestions</SectionHeader>
            )}
            {suggestions.map((row, j) => {
              const i = matches.length + j;
              return (
                <Row
                  key={`s-${row.id}`}
                  row={row}
                  active={activeIdx === i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(row)}
                />
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <p className={styles.header}>{children}</p>;
}

function Row({
  row, active, onMouseEnter, onClick,
}: {
  row: CustomerRow;
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={styles.row}
      data-active={active || undefined}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <span className={styles.name}>{row.full_name}</span>
      <span className={styles.meta}>
        <span className={styles.phone}>
          {row.phone_country} {row.phone_number || "—"}
        </span>
        {row.home_store_name && (
          <span> · from {row.home_store_name}</span>
        )}
      </span>
    </button>
  );
}

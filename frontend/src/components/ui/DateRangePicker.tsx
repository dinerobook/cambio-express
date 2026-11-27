import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type DateRange } from "react-day-picker";
import { es } from "react-day-picker/locale";
import "react-day-picker/src/style.css";
import "./dayPicker.css";

import {
  matchingPreset, presetRange, RANGE_PRESETS, rangeLabel, type IsoRange,
  type RangePreset,
} from "../../lib/dateRanges";
import { toIsoDate, todayIso } from "../../lib/datetime";
import { t, useLanguage, type MessageKey } from "../../i18n";
import { Button } from "./Button";
import { ModalActions } from "./Modal";
import styles from "./DateRangePicker.module.css";

const PRESET_LABELS: Record<RangePreset, MessageKey> = {
  this_month: "range.this_month",
  last_month: "range.last_month",
  this_quarter: "range.this_quarter",
  last_quarter: "range.last_quarter",
  this_year: "range.this_year",
  last_year: "range.last_year",
  last_30_days: "range.last_30_days",
};

const day = (iso: string) => new Date(`${iso}T00:00:00`);

/**
 * The ONE date range control (UI-STANDARDS §4 "Date ranges"): a
 * button that opens the preset periods (this / last month, quarter,
 * year, last 30 days) beside two calendars for a custom range. A
 * preset applies at once; a custom range applies with "Apply". The
 * periods are worked out from the store's day (`lib/dateRanges.ts`).
 * On a narrow screen one calendar shows and the presets sit above it.
 */
export function DateRangePicker({
  value, onChange, today = todayIso(), "aria-label": ariaLabel,
}: {
  value: IsoRange;
  onChange: (next: IsoRange) => void;
  /** The store's day (`YYYY-MM-DD`); tests pin it. */
  today?: string;
  "aria-label"?: string;
}) {
  const lang = useLanguage();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const active = matchingPreset(value, today);
  const narrow = typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 40rem)").matches;

  function openChange(next: boolean) {
    if (next) setDraft({ from: day(value.from), to: day(value.to) });
    setOpen(next);
  }

  function apply(r: IsoRange) {
    onChange(r);
    setOpen(false);
  }

  const ready = draft?.from && draft.to;

  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger asChild>
        <button
          type="button" className={styles.trigger}
          aria-label={ariaLabel ? `${ariaLabel}: ${rangeLabel(value)}` : undefined}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <line x1="3" y1="10" x2="21" y2="10" />
            <line x1="8" y1="3" x2="8" y2="7" />
            <line x1="16" y1="3" x2="16" y2="7" />
          </svg>
          <span>{active ? t(PRESET_LABELS[active]) : rangeLabel(value)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`${styles.popover} db-calendar`} side="bottom" align="end"
          sideOffset={4} collisionPadding={8}
          aria-label={t("range.dialog")}
        >
          <div className={styles.body}>
            <ul className={styles.presets} aria-label={t("range.presets")}>
              {RANGE_PRESETS.map((p) => (
                <li key={p}>
                  <button
                    type="button"
                    className={p === active ? styles.presetActive : styles.preset}
                    aria-pressed={p === active}
                    onClick={() => apply(presetRange(p, today))}
                  >
                    {t(PRESET_LABELS[p])}
                  </button>
                </li>
              ))}
              <li className={styles.customLabel}>{t("range.custom")}</li>
            </ul>
            <div className={styles.calendars}>
              <DayPicker
                mode="range"
                numberOfMonths={narrow ? 1 : 2}
                selected={draft}
                onSelect={setDraft}
                defaultMonth={day(value.from)}
                locale={lang === "es" ? es : undefined}
              />
              <div className={styles.footer}>
                <span className={styles.picked}>
                  {ready
                    ? rangeLabel({ from: toIsoDate(draft.from!), to: toIsoDate(draft.to!) })
                    : t("range.pickEnd")}
                </span>
                <ModalActions>
                  <Button tone="secondary" size="sm" onClick={() => setOpen(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    tone="primary" size="sm" disabled={!ready}
                    onClick={() => {
                      if (draft?.from && draft.to) {
                        apply({ from: toIsoDate(draft.from), to: toIsoDate(draft.to) });
                      }
                    }}
                  >
                    {t("range.apply")}
                  </Button>
                </ModalActions>
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

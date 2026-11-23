import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  pullStoreBookRegister, restoreStoreBookField, setStoreBookLock,
  updateStoreBookDay, useStoreBookDay, storeBookLabel,
  type StoreBookDay as StoreBookSheet, type StoreBookField,
  type StoreBookRegisterDay, type StoreBookRegisterItem,
} from "../api/storebook";
import {
  Alert, Button, ButtonLink, Card, ConfirmDialog, ErrorState, Field,
  Input, Loading, MoneyInput, PageShell, PeriodStepper, Pill, Textarea,
  useToast,
} from "../components/ui";
import {
  ColumnHeader, DayStepLabel, DayToolbar, LockButton, OverShortReadout,
  type ColumnTone,
} from "../components/DayBookChrome";
import RegisterCloses from "../components/RegisterCloses";
import { canDo } from "../lib/access";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import {
  addDaysIso, formatDateTime, formatDayLabel, formatTime, todayIso,
} from "../lib/datetime";
import styles from "./StoreBookDay.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// /app/store-book/day?date=YYYY-MM-DD — one store day.
//
// Three columns that balance: Sales, Tenders, Deposit & balance.
// over/short is tenders − sales and it is the point of the page,
// so it recomputes as you type rather than on save.
//
// The frame is the one the MSB daily book uses (DayBookChrome): a
// sticky toolbar with the day stepper dead centre and over/short +
// lock on the right, and a sticky total on top of each column.
//
// The layout comes from the API (`layout`), not from a copy here —
// a new field on the sheet appears without a frontend change.
//
// The register's day close (`register_day`, stores with the feed
// switched on): opening a day whose register figures the sheet has
// not taken takes them, with no button to press. An empty box is
// filled; a box somebody typed in keeps its number, and the
// register's figure shows under it, green when the two agree and red
// when they differ.

// MoneyInput works in DOLLARS; the API and the totals work in
// cents. These two are the only place the boundary is crossed.
function centsToDollars(cents: number): number {
  return cents / 100;
}
function dollarsToCents(dollars: number): number {
  return Math.round((dollars || 0) * 100);
}

const COLUMN_TONE: Record<string, ColumnTone> = {
  sales: "accent", tenders: "info", deposit: "neutral",
};

const NOTES_KEY = "notes";

export default function StoreBookDay() {
  const t = useT();
  const [sp, setSP] = useSearchParams();
  const day = sp.get("date") || todayIso();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();

  const { data, isLoading, isError, refetch } = useStoreBookDay(day);
  const groupIdBase = useId();

  // Local edit buffer. MoneyInput is a controlled number field, so
  // money is held in dollars; counts stay strings. A box is saved
  // when the cursor leaves its row.
  const [money, setMoney] = useState<Record<string, number>>({});
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmLock, setConfirmLock] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // Boxes typed in and not saved yet, each with how many times it
  // was typed in. A fresh answer from the server (a save of another
  // box, the register's numbers, a restore) fills every box EXCEPT
  // these, so it never wipes what is being typed.
  const dirty = useRef(new Map<string, number>());
  const hydratedFor = useRef<string | null>(null);

  function touch(key: string) {
    dirty.current.set(key, (dirty.current.get(key) ?? 0) + 1);
  }

  useEffect(() => {
    if (!data) return;
    const sheet = `${data.store_id}:${data.entry_date}`;
    const fresh = hydratedFor.current !== sheet;
    if (fresh) {
      hydratedFor.current = sheet;
      dirty.current.clear();
    }
    const typing = dirty.current;
    // Hydrate the edit buffer from the fetched day, keeping the boxes
    // being typed in.
    setMoney((prev) => {
      const next: Record<string, number> = {};
      for (const [k, v] of Object.entries(data.values)) {
        next[k] = typing.has(k) ? prev[k] ?? 0 : centsToDollars(v);
      }
      return next;
    });
    setCounts((prev) => {
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(data.counts)) {
        next[k] = typing.has(k) ? prev[k] ?? "" : v ? String(v) : "";
      }
      return next;
    });
    if (!typing.has(NOTES_KEY)) setNotes(data.notes || "");
    if (fresh) {
      setSavedAt(null);
      setServerError(null);
    }
  }, [data]);

  // Totals recomputed from the buffer so the header tracks typing
  // rather than the last save. Column membership comes from the
  // server-supplied layout, so this can't disagree with the API.
  const totals = useMemo(() => {
    const columns: Record<string, number> = { sales: 0, tenders: 0, deposit: 0 };
    for (const column of data?.layout ?? []) {
      for (const section of column.sections) {
        for (const f of section.fields) {
          columns[column.column] = (columns[column.column] ?? 0)
            + dollarsToCents(money[f.key] ?? 0);
        }
      }
    }
    return { columns, overShort: columns.tenders - columns.sales };
  }, [data, money]);

  const locked = data?.is_locked ?? false;
  const canEdit = canDo("day_close.update");
  const readOnly = locked || !canEdit;
  const register = data?.register_day ?? null;

  function store(next: StoreBookSheet) {
    qc.setQueryData(
      ["storebook", "day", next.store_id, next.entry_date], next,
    );
    void qc.invalidateQueries({ queryKey: ["storebook", "month"] });
  }

  /** Save the boxes in `keys` if any of them was typed in. */
  async function save(
    keys: string[], body: Parameters<typeof updateStoreBookDay>[1],
  ) {
    if (readOnly) return;
    const sent = keys
      .filter((k) => dirty.current.has(k))
      .map((k) => [k, dirty.current.get(k)] as const);
    if (sent.length === 0) return;
    setServerError(null);
    try {
      const next = await updateStoreBookDay(day, body);
      // Typed in again while the save was on its way: still unsaved.
      for (const [k, stamp] of sent) {
        if (dirty.current.get(k) === stamp) dirty.current.delete(k);
      }
      store(next);
      setSavedAt(new Date());
    } catch (err) {
      setServerError(apiErrorMessage(err, t("sbDay.saveFailed")));
    }
  }

  function saveRow(f: StoreBookField) {
    const keys = [f.key];
    const body: Parameters<typeof updateStoreBookDay>[1] = {
      values: { [f.key]: dollarsToCents(money[f.key] ?? 0) },
    };
    const c: Record<string, number> = {};
    for (const companion of [f.count_field, f.gallons_field]) {
      if (!companion) continue;
      keys.push(companion);
      c[companion] = Number(counts[companion] ?? 0) || 0;
    }
    if (Object.keys(c).length) body.counts = c;
    void save(keys, body);
  }

  /** Take the register's day close onto the sheet. `quiet` is the
   *  page doing it by itself as a day opens: no toast either way. */
  async function pullRegister(quiet: boolean) {
    setPulling(true);
    try {
      store(await pullStoreBookRegister(day));
      if (!quiet) toast({ message: t("sbDay.reg.taken"), tone: "success" });
    } catch (err) {
      if (!quiet) toastApiError(err, t("sbDay.reg.failed"));
    } finally {
      setPulling(false);
    }
  }

  // Opening a day takes the register's numbers when it holds some
  // the sheet has not taken: once per day and per arrival, so a
  // refusal (a read-only session) is never retried in a loop.
  const autoPulled = useRef<string | null>(null);
  const pendingKey = data && register?.pending && !locked && canEdit
    ? `${data.store_id}:${data.entry_date}:${register.received_at ?? ""}`
    : null;
  useEffect(() => {
    if (pendingKey == null || autoPulled.current === pendingKey) return;
    autoPulled.current = pendingKey;
    void pullRegister(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the day and the arrival; pullRegister reads `day`, which the key already holds
  }, [pendingKey]);

  async function onRefreshRegister() {
    if (register?.ready && !readOnly) {
      await pullRegister(false);
    } else {
      setPulling(true);
      try {
        await refetch();
      } finally {
        setPulling(false);
      }
    }
  }

  async function onToggleLock() {
    setBusy(true);
    try {
      const next = await setStoreBookLock(day, !locked);
      store(next);
      toast({
        message: next.is_locked ? t("sbDay.locked") : t("sbDay.unlocked"),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("sbDay.lockFailed"));
    } finally {
      setBusy(false);
      setConfirmLock(false);
    }
  }

  async function onRestore(fieldKey: string) {
    setBusy(true);
    // The register's number is what the box should now show, whatever
    // was typed in it.
    dirty.current.delete(fieldKey);
    try {
      store(await restoreStoreBookField(day, fieldKey));
      toast({ message: t("sbDay.restored"), tone: "success" });
    } catch (err) {
      toastApiError(err, t("sbDay.restoreFailed"));
    } finally {
      setBusy(false);
    }
  }

  function goToDay(next: string) {
    const params = new URLSearchParams(sp);
    params.set("date", next);
    setSP(params, { replace: true });
  }

  // Lines where the register's figure and the box disagree.
  const changed = data
    ? Object.entries(data.originals).filter(
      ([k, cents]) => cents !== dollarsToCents(money[k] ?? 0),
    ).length
    : 0;

  return (
    <PageShell gap="1rem">
      {/* Sticky: crumbs · day stepper · over/short + lock. It stays
          on screen while a day loads, so stepping through days never
          takes the arrows from under the cursor. */}
      <DayToolbar
        lead={<PageCrumbs current={formatDayLabel(day)} />}
        trail={
          <>
            <OverShortReadout
              label={t("sbDay.overShort")}
              tip={t("sbDay.overShortTip")}
              value={totals.overShort / 100}
              negative={totals.overShort < 0}
            />
            {locked ? (
              <Pill tone="warning" dot>
                {t("daily.lockedAt", { at: formatDateTime(data?.locked_at) })}
              </Pill>
            ) : savedAt ? (
              <Pill tone="accent">
                {t("daily.savedAt", { time: formatTime(savedAt) })}
              </Pill>
            ) : null}
            {/* Locking needs Edit on this book AND the "Lock / unlock
                days" switch, like the server's lock route. */}
            {data && canDo("day_lock.update") && (
              <LockButton
                locked={locked} busy={busy} perm="day_close.update"
                lockLabel={t("sbDay.lockDay")} unlockLabel={t("sbDay.unlock")}
                onToggle={() => {
                  if (locked) void onToggleLock();
                  else setConfirmLock(true);
                }}
              />
            )}
          </>
        }
      >
        <PeriodStepper
          unit="day"
          variant="chevrons"
          arrowKeys
          onPrev={() => goToDay(addDaysIso(day, -1))}
          onNext={() => goToDay(addDaysIso(day, 1))}
          onCalendar={() => navigate("/store-book")}
        >
          <DayStepLabel>{formatDayLabel(day)}</DayStepLabel>
        </PeriodStepper>
      </DayToolbar>

      {isLoading && <Loading />}
      {!isLoading && (isError || !data) && (
        <ErrorState
          message={t("sbDay.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <>
          {locked && (
            <Alert tone="info">
              {canEdit && canDo("day_lock.update")
                ? t("sbDay.lockedCanUnlock")
                : t("sbDay.lockedAskAdmin")}
            </Alert>
          )}
          {serverError && <Alert tone="error">{serverError}</Alert>}

          {register && (
            <RegisterStrip
              register={register}
              changed={changed}
              locked={locked}
              canEdit={canEdit}
              busy={pulling}
              onRefresh={() => { void onRefreshRegister(); }}
            />
          )}

          <div className={styles.columns}>
            {data.layout.map((column) => (
              <div key={column.column} className={styles.column}>
                <ColumnHeader
                  label={storeBookLabel(column.column, column.label, "column")}
                  value={(totals.columns[column.column] ?? 0) / 100}
                  tone={COLUMN_TONE[column.column] ?? "neutral"}
                />
                {/* One card per column: a ledger, not a wall of boxes.
                    A group's heading is left out when it would only
                    repeat the name of its one line. */}
                <Card className={styles.sheet} padding="0.2rem 0.9rem">
                  {column.sections.map((section) => {
                    const title = storeBookLabel(section.key, section.label);
                    const only = section.fields.length === 1
                      ? section.fields[0] : null;
                    const repeats = only != null
                      && storeBookLabel(only.key, only.label) === title;
                    const titleId = `${groupIdBase}-${section.key}`;
                    return (
                      <div
                        key={section.key} className={styles.group}
                        // A group of one line that carries the same
                        // name needs no second announcement.
                        role={repeats ? undefined : "group"}
                        aria-labelledby={repeats ? undefined : titleId}
                      >
                        {!repeats && (
                          <div id={titleId} className={styles.groupTitle}>
                            {title}
                          </div>
                        )}
                        {section.fields.map((f) => (
                          <BookRow
                            key={f.key}
                            field={f}
                            readOnly={readOnly}
                            value={money[f.key] ?? 0}
                            countValue={
                              f.count_field ? counts[f.count_field] ?? "" : ""
                            }
                            gallonsValue={
                              f.gallons_field
                                ? counts[f.gallons_field] ?? "" : ""
                            }
                            original={data.originals[f.key]}
                            onMoney={(v) => {
                              touch(f.key);
                              setMoney((m) => ({ ...m, [f.key]: v }));
                            }}
                            onCompanion={(key, v) => {
                              touch(key);
                              setCounts((c) => ({ ...c, [key]: v }));
                            }}
                            onCommit={() => saveRow(f)}
                            onRestore={() => { void onRestore(f.key); }}
                          />
                        ))}
                      </div>
                    );
                  })}
                </Card>
              </div>
            ))}
          </div>

          {/* Per-register Z-report detail for the same day. The sheet
              above is what the store banked; this is which drawer it
              came out of — one screen, one day. */}
          <RegisterCloses day={day} canEdit={!locked} />

          <Card>
            <Field label={t("sbDay.notes")}>
              <Textarea
                rows={3}
                value={notes}
                disabled={readOnly}
                onChange={(e) => {
                  touch(NOTES_KEY);
                  setNotes(e.target.value);
                }}
                onBlur={() => { void save([NOTES_KEY], { notes }); }}
              />
            </Field>
          </Card>
        </>
      )}

      <ConfirmDialog
        open={confirmLock}
        title={t("sbDay.lockTitle")}
        message={t("sbDay.lockMessage")}
        confirmLabel={t("sbDay.lockDay")}
        busy={busy}
        onConfirm={() => { void onToggleLock(); }}
        onCancel={() => setConfirmLock(false)}
      />
    </PageShell>
  );
}


/** One line of the sheet: its name on the left, the money box (with
 *  its count or gallons box) on the right, and under them the
 *  register's figure when the register reported one. */
function BookRow({
  field, readOnly, value, countValue, gallonsValue, original,
  onMoney, onCompanion, onCommit, onRestore,
}: {
  field: StoreBookField;
  readOnly: boolean;
  value: number;
  countValue: string;
  gallonsValue: string;
  /** Cents the register reported; undefined on a hand-typed line. */
  original?: number;
  onMoney: (v: number) => void;
  onCompanion: (key: string, v: string) => void;
  onCommit: () => void;
  onRestore: () => void;
}) {
  const t = useT();
  const captionId = useId();
  const label = storeBookLabel(field.key, field.label);
  const cents = dollarsToCents(value);
  // $0.00 on both sides says nothing: the line stays quiet until
  // either the register or a person puts a number on it.
  const hasRegister = original != null && !(original === 0 && cents === 0);
  const differs = hasRegister && original !== cents;
  const amount = fmtMoney2((original ?? 0) / 100);

  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div
        className={styles.rowInputs}
        onBlur={(e) => {
          // Moving between the count box and the money box of the
          // same line is not leaving the line.
          if (!e.currentTarget.contains(e.relatedTarget)) onCommit();
        }}
      >
        {/* The kit input is as wide as its box, so each companion
            gets a box of its own width. */}
        {field.count_field && (
          <div className={styles.countBox}>
            <Input
              type="number" inputMode="numeric"
              aria-label={t("sbDay.countOf", { label })}
              placeholder="#"
              value={countValue}
              disabled={readOnly}
              onChange={(e) => onCompanion(field.count_field!, e.target.value)}
            />
          </div>
        )}
        {field.gallons_field && (
          <div className={styles.gallonsBox}>
            <Input
              type="number" step="0.001" inputMode="decimal"
              aria-label={t("sbDay.gallons")}
              placeholder={t("sbDay.gal")}
              value={gallonsValue}
              disabled={readOnly}
              onChange={(e) => onCompanion(field.gallons_field!, e.target.value)}
            />
          </div>
        )}
        <div className={styles.moneyBox}>
          <MoneyInput
            aria-label={label}
            aria-describedby={hasRegister ? captionId : undefined}
            value={value}
            onChange={onMoney}
            disabled={readOnly}
            fullWidth
            dense
          />
        </div>
      </div>
      {hasRegister && (
        // Green + a tick while the box still holds the register's
        // number, red + a "not equal" mark once it differs: never
        // colour alone.
        <div
          id={captionId}
          className={`${styles.reg} ${differs ? styles.regDiffers : styles.regMatch}`}
        >
          {differs
            ? <DiffersIcon label={t("sbDay.reg.differs")} />
            : <MatchIcon label={t("sbDay.reg.matches")} />}
          <span>{t("sbDay.reg.value", { amount })}</span>
          {differs && !readOnly && (
            <button
              type="button"
              className={styles.regUse}
              title={t("sbDay.restore")}
              aria-label={`${t("sbDay.reg.use")}: ${t("sbDay.reg.value", { amount })}`}
              onClick={onRestore}
            >
              {t("sbDay.reg.use")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


/** What the register's day close says about this day: the period it
 *  covers, how many lines a person changed, and anything it reported
 *  that the sheet could not place. */
function RegisterStrip({
  register, changed, locked, canEdit, busy, onRefresh,
}: {
  register: StoreBookRegisterDay;
  changed: number;
  locked: boolean;
  canEdit: boolean;
  busy: boolean;
  onRefresh: () => void;
}) {
  const t = useT();

  if (!register.has_data) {
    return (
      <div className={`${styles.register} ${styles.registerQuiet}`}>
        <RegisterIcon />
        <span className={styles.registerMeta}>{t("sbDay.reg.none")}</span>
      </div>
    );
  }

  const period = register.period_start && register.period_end
    ? t("sbDay.reg.period", {
      from: formatDateTime(register.period_start),
      to: formatDateTime(register.period_end),
    })
    : "";
  const itemName = (i: StoreBookRegisterItem) => (
    i.kind === "payment_type"
      ? t("sbDay.reg.paymentType", { code: i.code })
      : [i.code, i.name].filter(Boolean).join(" · ")
  );

  return (
    <div className={styles.register}>
      <RegisterIcon />
      <div className={styles.registerText}>
        <span className={styles.registerTitle}>{t("sbDay.reg.title")}</span>
        {period && <span className={styles.registerMeta}>{period}</span>}
      </div>
      <div className={styles.registerTrail}>
        {register.ready && !register.pending && (
          changed === 0
            ? <Pill tone="accent" dot>{t("sbDay.reg.allMatch")}</Pill>
            : (
              <Pill tone="warning" dot>
                {t("sbDay.reg.changed", { count: changed })}
              </Pill>
            )
        )}
        <Button
          tone="secondary" size="sm" busy={busy}
          title={t("sbDay.reg.refreshTitle")}
          onClick={onRefresh}
        >
          {t("sbDay.reg.refresh")}
        </Button>
      </div>

      {register.problem === "waiting" && (
        <p className={styles.registerNote}>{t("sbDay.reg.waiting")}</p>
      )}
      {register.problem === "departments" && (
        <div className={`${styles.registerNote} ${styles.registerWarn}`}>
          <span>{t("sbDay.reg.departments")}</span>
          <ItemList items={register.unmapped} name={itemName} />
          <ButtonLink to="/account/departments" tone="secondary" size="sm">
            {t("sbDay.reg.departmentsLink")}
          </ButtonLink>
        </div>
      )}
      {register.problem === "tax_split" && (
        <div className={`${styles.registerNote} ${styles.registerWarn}`}>
          <span>{t("sbDay.reg.taxSplit")}</span>
          <ButtonLink to="/account/departments" tone="secondary" size="sm">
            {t("sbDay.reg.departmentsLink")}
          </ButtonLink>
        </div>
      )}
      {register.pending && (locked || !canEdit) && (
        <p className={`${styles.registerNote} ${styles.registerWarn}`}>
          {locked ? t("sbDay.reg.pendingLocked") : t("sbDay.reg.pendingView")}
        </p>
      )}
      {register.ready && register.unplaced.length > 0 && (
        <div className={styles.registerNote}>
          <span>{t("sbDay.reg.unplaced")}</span>
          <ItemList items={register.unplaced} name={itemName} />
        </div>
      )}
    </div>
  );
}

function ItemList({
  items, name,
}: {
  items: StoreBookRegisterItem[];
  name: (i: StoreBookRegisterItem) => string;
}) {
  return (
    <ul className={styles.registerItems}>
      {items.map((i) => (
        <li key={`${i.kind}:${i.code}`} className={styles.registerItem}>
          <span>{name(i)}</span>
          <span className={styles.registerAmount}>
            {fmtMoney2(i.amount_cents / 100)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// Inline stroke SVGs (design system: stroke-width 2, round caps,
// currentColor, fill none). The caption marks carry a name, so the
// meaning is read out with the box and never rests on colour alone.
function MatchIcon({ label }: { label: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round"
      strokeLinejoin="round" role="img" aria-label={label}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function DiffersIcon({ label }: { label: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round"
      strokeLinejoin="round" role="img" aria-label={label}>
      <path d="M5 9h14M5 15h14M16 4L8 20" />
    </svg>
  );
}

function RegisterIcon() {
  return (
    <svg className={styles.registerIcon} width="18" height="18"
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="13" width="18" height="8" rx="1.5" />
      <path d="M7 13V5h10v8M10 8h4M11 17h2" />
    </svg>
  );
}

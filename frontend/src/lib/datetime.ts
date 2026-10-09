// Date / time rendering helpers.
//
// Single source of truth for "what timezone do we render in?"
// across the SPA: the STORE's timezone (Settings → General). The
// shell sets it once from session-status (`setDisplayTimezone`,
// see `DisplayTimezoneSync` in AppShell) and every helper below
// reads it, so a page never threads a timezone through props.
// The server picks the zone: the store's, else the person's own
// (store-less principals: superadmin, owner portfolio), else ""
// — and "" means "the device's timezone".
//
// The server stores every timestamp as NAIVE UTC and serialises
// it without an offset ("2026-10-09T15:00:00"). JavaScript reads
// an offset-less date-time as LOCAL time, which shifted every
// time in the app by the browser's UTC offset (a 10:00 lock in
// Chicago read 3:00 PM). `parseTimestamp` is the one parser that
// reads those strings as UTC — never `new Date(apiString)`.

// Last known zone, per device, so the first paint after a reload
// is already right while session-status is in flight.
const _TZ_CACHE_KEY = "dinerobook.display_tz";

let _displayTz: string | undefined = (() => {
  try {
    const cached = localStorage.getItem(_TZ_CACHE_KEY) || "";
    return cached && isValidTimezone(cached) ? cached : undefined;
  } catch {
    return undefined;
  }
})();

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Set the timezone every helper renders in. Blank or unknown
 *  values clear it (the device's timezone is used). */
export function setDisplayTimezone(tz: string | null | undefined): void {
  const t = (tz || "").trim();
  _displayTz = t && isValidTimezone(t) ? t : undefined;
  try {
    if (_displayTz) localStorage.setItem(_TZ_CACHE_KEY, _displayTz);
    else localStorage.removeItem(_TZ_CACHE_KEY);
  } catch {
    // Storage blocked (private mode) — the in-memory zone still works.
  }
}

/** The timezone the helpers render in; ``undefined`` = the device's. */
export function getDisplayTimezone(): string | undefined {
  return _displayTz;
}

/** An explicit per-call zone wins; otherwise the display zone. */
function zoneFor(timeZone?: string | null): string | undefined {
  const t = (timeZone || "").trim();
  if (t && isValidTimezone(t)) return t;
  return _displayTz;
}

const _NAIVE_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;
const _DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an API timestamp. Offset-less date-times are UTC (how the
 *  server stores them); strings with ``Z`` / ``+hh:mm`` keep their
 *  offset. Returns ``null`` for empty or unparseable input. Bare
 *  ``YYYY-MM-DD`` days are not instants — use ``formatDate``. */
export function parseTimestamp(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const s = iso.trim();
  const m = _NAIVE_DATETIME.exec(s);
  // Python's isoformat() can carry microseconds; keep milliseconds.
  const v = m ? `${m[1]}T${m[2]}${(m[3] || "").slice(0, 4)}Z` : s;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(
  d: Date, opts: Intl.DateTimeFormatOptions, timeZone?: string | null,
): string {
  return new Intl.DateTimeFormat("en-US", {
    ...opts, timeZone: zoneFor(timeZone),
  }).format(d);
}

/** A bare ``YYYY-MM-DD`` names a calendar day, not an instant: it
 *  renders as that day verbatim, never shifted by a timezone. */
function calendarDay(iso: string): Date | null {
  if (!_DATE_ONLY.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

type TzOpt = { timeZone?: string | null };

function render(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions,
  o: TzOpt,
  empty = "—",
): string {
  if (!iso) return empty;
  const day = calendarDay(iso);
  if (day) {
    // Calendar days: format in UTC so the day never moves.
    const dayOpts = { ...opts };
    delete dayOpts.hour; delete dayOpts.minute; delete dayOpts.hourCycle;
    delete dayOpts.timeZoneName;
    return new Intl.DateTimeFormat("en-US", { ...dayOpts, timeZone: "UTC" })
      .format(day);
  }
  const d = parseTimestamp(iso);
  if (!d) return iso;
  return fmt(d, opts, o.timeZone);
}


/** Full timestamp with the zone named, for audit trails and logs:
 *  ``Oct 9, 2026, 10:00 CDT``. */
export function formatTimestamp(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  if (!iso) return "—";
  const d = parseTimestamp(iso);
  if (!d) return iso;
  const base = fmt(d, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hourCycle: "h23",
  }, o.timeZone);
  const tzLabel = formatTzAbbrev(d, zoneFor(o.timeZone));
  return tzLabel ? `${base} ${tzLabel}` : base;
}


/** Date-only cell formatter: ``Oct 9, 2026``. Accepts timestamps
 *  (the store-local day they fall on) AND bare ``YYYY-MM-DD``
 *  strings (rendered verbatim). The standard cell formatter
 *  (UI-STANDARDS §4); never ``iso.slice(0, 10)``. */
export function formatDate(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  return render(iso, { month: "short", day: "numeric", year: "numeric" }, o);
}

/** Short date: ``Oct 9`` — chart labels and compact cells. */
export function formatShortDate(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  return render(iso, { month: "short", day: "numeric" }, o);
}

/** Compact date: ``10/09/26`` — dense report tables. */
export function formatDateCompact(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  return render(
    iso, { month: "2-digit", day: "2-digit", year: "2-digit" }, o, "",
  );
}

/** Day heading with the weekday: ``Fri, Oct 9, 2026``. */
export function formatDayLabel(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  return render(iso, {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  }, o);
}

/** Date and time without the year: ``Oct 9, 10:00 AM`` — activity
 *  feeds, "locked at", "as of". */
export function formatDateTime(
  iso: string | null | undefined, o: TzOpt = {},
): string {
  return render(iso, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }, o);
}

/** Time of day only: ``10:00 AM``. Accepts an API timestamp or a
 *  ``Date`` (e.g. "saved at" stamps taken in the browser). */
export function formatTime(
  value: string | Date | null | undefined, o: TzOpt = {},
): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : parseTimestamp(value);
  if (!d) return typeof value === "string" ? value : "—";
  return fmt(d, { hour: "numeric", minute: "2-digit" }, o.timeZone);
}


/** Month names, January first: index with ``month - 1`` for a
 *  1-based month, or ``getMonth()`` directly. */
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** Three-letter month names, same indexing as ``MONTH_NAMES``. */
export const MONTH_NAMES_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;


/** A ``Date`` built from calendar fields (a picker click, a grid
 *  cell) as ``YYYY-MM-DD``, read from its LOCAL fields. Not for
 *  "now": use ``todayIso`` / ``storeNow``, which follow the store's
 *  timezone. ``toISOString().slice(0, 10)`` reads the UTC day,
 *  which is already tomorrow for a US store after about 7pm. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}


interface ZonedParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
}

function zonedParts(d: Date, tz: string | undefined): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const n = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: n("year"), month: n("month"), day: n("day"),
    hour: n("hour") % 24, minute: n("minute"), second: n("second"),
  };
}

/** The store's wall clock now, as a ``Date`` whose LOCAL fields
 *  (getFullYear / getMonth / getDate / getHours) read the store's
 *  date and time. For calendar math — "this month", "this week" —
 *  never for display or for sending to the server. */
export function storeNow(now: Date = new Date()): Date {
  const p = zonedParts(now, _displayTz);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Today's calendar day in the store's timezone, ``YYYY-MM-DD``. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate(storeNow(now));
}


/** The store's calendar day ``n`` days before ``now`` (negative
 *  ``n`` looks ahead), as ``YYYY-MM-DD``. */
export function daysAgoIso(n: number, now: Date = new Date()): string {
  return addDaysIso(todayIso(now), -n);
}


/** First day of the store's current month as ``YYYY-MM-DD``. */
export function monthStartIso(now: Date = new Date()): string {
  return `${todayIso(now).slice(0, 8)}01`;
}


/** Offset of ``tz`` from UTC at instant ``d``, in milliseconds. */
function tzOffsetMs(d: Date, tz: string | undefined): number {
  const p = zonedParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/** A ``datetime-local`` input value (``YYYY-MM-DDTHH:mm``), read as
 *  the store's wall clock, as a UTC ISO string for the API. ``""``
 *  for blank or malformed input. */
export function zonedInputToUtcIso(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || "");
  if (!m) return "";
  const guess = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]),
  );
  // Two passes settle the offset across a DST change.
  let t = guess - tzOffsetMs(new Date(guess), _displayTz);
  t = guess - tzOffsetMs(new Date(t), _displayTz);
  return new Date(t).toISOString();
}

/** An API timestamp as a ``datetime-local`` input value on the
 *  store's wall clock. ``""`` for empty or unparseable input. */
export function utcToZonedInput(iso: string | null | undefined): string {
  const d = parseTimestamp(iso);
  if (!d) return "";
  const p = zonedParts(d, _displayTz);
  const z = (v: number) => String(v).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}


/** Add ``delta`` days to a ``YYYY-MM-DD`` calendar date, returning a
 *  new ``YYYY-MM-DD`` string. Timezone-safe: the date is built at UTC
 *  midnight and stepped in UTC, so a local offset or DST boundary can
 *  never bump the result onto the wrong calendar day. Returns the
 *  input unchanged when it isn't a valid ISO date (defensive — callers
 *  pass a route param). Used by the daily-book day stepper. */
export function addDaysIso(iso: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}


/** One entry of the ``Store.store_hours`` array (mirrors the
 *  backend ``StoreHourEntry`` Pydantic shape). */
export interface StoreHourLike {
  day:    number;
  open:   string;
  close:  string;
  closed: boolean;
}


/** Status returned by ``getOpenStatus`` — drives the UI pill on
 *  Dashboard + the soft warning on the New Transfer form. */
export interface OpenStatus {
  /** True when the current moment (in the resolved timezone) is
   *  inside the day's open window; false when the day is
   *  ``closed`` or before / after the window. */
  open: boolean;
  /** ``"09:00 - 18:00"`` style label for the current day —
   *  empty string when the store is closed today. */
  todayLabel: string;
  /** Day-of-week label for the row we looked at (``"Monday"``
   *  etc.) — useful for the pill tooltip. */
  dayLabel: string;
}


const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday",
] as const;

/** Resolve whether the store is open right now per its 7-day
 *  schedule, evaluated in the store's local timezone. Returns
 *  null when ``hours`` is missing / malformed — callers should
 *  treat that as "no opinion, don't show an indicator". */
export function getOpenStatus(
  hours: StoreHourLike[] | null | undefined,
  storeTimezone?: string | null,
  now: Date = new Date(),
): OpenStatus | null {
  if (!Array.isArray(hours) || hours.length !== 7) return null;
  const tz = zoneFor(storeTimezone);
  // Parse the wall-clock weekday + minute-of-day in the target tz.
  // ``Intl.DateTimeFormat`` with a single ``weekday`` part returns
  // English long names; we map back to the ISO 0..6 we store.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) partMap[p.type] = p.value;
  const weekdayIdx = DAY_NAMES.indexOf(
    partMap.weekday as typeof DAY_NAMES[number],
  );
  if (weekdayIdx < 0) return null;
  const hh = Number(partMap.hour);
  const mm = Number(partMap.minute);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const row = hours.find((h) => h.day === weekdayIdx);
  if (!row) return null;
  const dayLabel = DAY_NAMES[weekdayIdx];
  if (row.closed) {
    return { open: false, todayLabel: "", dayLabel };
  }
  const openMin  = _toMinutes(row.open);
  const closeMin = _toMinutes(row.close);
  if (openMin == null || closeMin == null) {
    return null;
  }
  const nowMin = hh * 60 + mm;
  return {
    open: nowMin >= openMin && nowMin < closeMin,
    todayLabel: `${row.open} - ${row.close}`,
    dayLabel,
  };
}

function _toMinutes(value: string): number | null {
  if (typeof value !== "string") return null;
  const m = /^([0-2]\d):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const hh = Number(m[1]);
  if (hh > 23) return null;
  return hh * 60 + Number(m[2]);
}


/** Pull a short timezone abbreviation ("CDT", "PST") from an Intl
 *  format pass. No ``tz`` names the device's own zone. */
function formatTzAbbrev(d: Date, tz?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(d);
    const part = parts.find((p) => p.type === "timeZoneName");
    return part ? part.value : "";
  } catch {
    // Bad TZ string — silently degrade rather than crashing the
    // render. The user can fix the value in settings.
    return "";
  }
}

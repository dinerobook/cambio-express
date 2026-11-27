# UI control & pattern standards — ONE way to do each thing

**Binding for all future development.** For every kind of data and
every kind of feedback there is exactly ONE control / pattern. If a
screen needs something this file doesn't cover, add the rule here in
the same PR that introduces it — never invent a second way to render
something that already has a row below.

The kit (`frontend/src/components/ui/index.tsx`) is the only place
controls come from. If the kit lacks a primitive you need, add it to
the kit first, then use it — never hand-roll one in a route.

---

## 1. Controls by data type

| Data | Control | Never |
|---|---|---|
| Boolean **setting** (feature/preference that applies immediately or on save: `enabled`, `enforce_business_hours`, `require_passkey`, theme, auto_post) | `<Switch>` | On/Off or Yes/No `<Select>`; radio pairs |
| Boolean **attribute of a record in a form** (`taxable`, `is_ebt`, `reconciled`, `is_active` on an edit form, "update costs") | `<Checkbox>` | Yes/No `<Select>`; radio pairs |
| Boolean **selection** ("include this row", store pickers, matrix cells) | `<Checkbox>` (with `aria-label` when the row provides the visible label) | raw `<input type="checkbox">` |
| Boolean toggled **from a table row** | `<RowActions>` item ("Deactivate"/"Reactivate", "Disable"/"Enable") | a Switch inside a table cell |
| Enum (3+ meaningful values) | `<Select>` | radios for >2 options unless all options must be visible at once |
| Two-to-four **modes that change what's below** (not a boolean) | radio group or `<TabsButton>` segmented control | — |
| Free text | `<Field>` + `<Input>` / `<Textarea>` | raw inputs |
| Money | `<MoneyInput>` | raw number inputs |
| Date | `<DateInput>` | raw `type="date"` |
| A **period** a page reads (from – to) | `<DateRangePicker>` (presets this / last month, quarter, year, last 30 days + two calendars; periods from `lib/dateRanges.ts`, the store's day) | two loose `<DateInput>`s; a page's own preset list |
| Phone | `<PhoneField>` | — |
| One of the store's own lists from Settings (money transfer companies, transfer countries) | `<StoreListField>` over `useTransferChoices()` | hard-coded options in the SPA |

Radio-for-a-boolean is banned: a two-option radio group whose value is
a single `true/false` is a `<Checkbox>` (form) or `<Switch>` (setting).

### Fields — one anatomy, every state

Every form control sits in a `<Field label hint error required>`
(owner's "forms have usability problems" pass, 2026-11-19). The kit
draws the rest, the same on every screen:

- **Label above, then the control, then the hint, then the error.**
  The hint and the error are outside the `<label>` and the kit
  controls (`Input`, `Select`, `Textarea`, `MoneyInput`, `Checkbox`)
  point at them with `aria-describedby` (`components/ui/fieldContext.ts`),
  so a screen reader reads the label as the name and the help as the
  description. Never put help text or an error inside `label=`.
- **Required** is `<Field required>`: one quiet `*` after the label and
  `aria-required` on the control. Never type `*` into a label string.
  A form marks the smaller group: `required` when most fields are
  optional (Add employee), "(optional)" in the label when most are
  required (New returned check).
- **Error** (`error=`, or `highlight` when the message is elsewhere):
  red label, red box edge (kept while focused, with a red glow), an
  alert icon before the message so the state never rests on colour,
  and `aria-invalid` on the control.
- **States come from the `.ds-input` rule** (`ui.css`): hover darkens
  the edge, keyboard focus is the neon edge + glow, read-only boxes take
  the card colour (they read as a value), disabled boxes dim to 60 %.
  `inputStyle` (`tokens.ts`) holds sizing only — a colour, border or
  padding written inline beats every state rule, so don't.
- **One height.** Input, Select, the date box and a `md` Button are all
  2.5rem, so a field and its button ("Link store") line up in a row.
- **Every control shows keyboard focus**: the money box draws it on its
  `$` + input frame (`.ds-money:focus-within`), a Switch on its track.
- **A date box shows its calendar mark** (`DateInput`), so it reads as
  a picker, not a text box.
- A checkbox inside a `<Field>` in a row of boxes sits on the boxes'
  text line (`.ds-field .ds-checkbox`).

## 2. Feedback

| Event | Pattern |
|---|---|
| Save/mutation succeeded, staying on page | `useToast()` `tone: "success"` |
| Save succeeded, navigating away | toast FIRST, then navigate (see `SuperadminStoreForm`) |
| Fetch failed (page/table data) | `<ErrorState message onRetry>` — always with retry; never `EmptyState` |
| Mutation/form failed | `<Alert tone="error">` (root) + `<Field error>` (per-field) |
| Data loading | list/table routes: `<TableStates>` (skeleton→error→empty); everything else: `<Loading />`. Never bare "Loading…" text, never an info Alert |
| Zero rows (whole region: table, tab pane, page section) | `<EmptyState title body>` — never an ad-hoc muted `<p>` |
| Zero rows (small in-card sub-list) or permission/scope gate | `<Empty>` |
| Destructive action | `<ConfirmDialog>` — never `window.confirm` / `alert()`. The title asks the question ("Delete this rule?", "Disconnect this bank?"), the confirm button repeats the verb ("Delete", "Disconnect"), and a destructive verb (Delete, Remove, Disconnect, Revoke, Deactivate, Unlink, Unpair) gets `confirmTone="danger"` (red) |
| Buttons at the bottom of a popup | `<Modal actions={…}>`, or `<ModalActions>` as the last child when the body is a `<form>` (the submit button must sit inside it). Cancel first, the primary action last, right-aligned, wrapping on a phone. The row stays pinned to the bottom of a long popup while the fields scroll behind it. Never a page-local `.modalActions` class or an inline flex row |
| Leaving a popup | every `<Modal>` has the ✕ in its top-right corner ("Close window", disabled while `disabled`), besides Escape and the backdrop. It is last in the DOM, so the first field still takes focus on open. Never a second hand-made ✕ |
| A popup's size | the card never grows past the window: its max height is the whole card (`box-sizing: border-box`; before 2026-11-19 a long popup was ~3rem taller than the screen and lost its title and Save off the edges). Widths: `sm` / `md` / `lg` for confirms, short forms, long forms; `xl` for a wide grid of inputs (the daily book's Services table). Nothing inside a popup scrolls sideways except a table in its own wrapper |
| A popup taller than the window | three parts: the header (title + ✕) and the button row stay put and only the body between them scrolls, with a scrollbar you can see. While more is below, the content fades into the button row and the row's edge darkens; once scrolled, a line runs under the header. Tab scrolls a field clear of a pinned row (`scroll-padding`). Never a popup whose last fields sit behind Save with nothing saying it scrolls (Add a department, owner's report 2026-11-19) |
| A popup on a phone (≤480px) | a sheet from the bottom edge, full width, rounded on top, as tall as the screen allows — the same shape as the row-actions sheet |
| Where focus lands in a popup | on the first field — not on a label's (i) button (its tip then covered the box) and not on a date box (its calendar then covered the buttons). No field: the first button; only a date box: the card. The kit does this; never set focus by hand |
| Every button row in a popup | is `<ModalActions>` — a form shown only in popups (`BankRuleForm`, the daily book's box editors) uses it too, never `<FormActions>` or a page-local save row, so Save stays pinned. Passing `<ModalActions>` to `actions=` draws one row, not a row in a row |
| Tabs inside a popup or a box | `<TabsBar wrap>`: they wrap onto a second line instead of hiding the last tab behind a 4px scrollbar (daily book `BoxTabs`) |
| The round help button (bottom-right) | nothing the person needs sits under it: `PageShell` leaves 5.5rem at the bottom of every page and a pinned `<FormActions>` bar keeps its right end clear |
| Form has edits that are not saved | the unsaved-changes guard — see "Unsaved changes" below |

### Unsaved changes — one guard on every form

Every page or inline form where someone types data that a Save
button stores uses the same guard. Owner's standard (2026-10-21):
"if a form is edited it says unsaved changes, and leaving or
refreshing warns that the changes will be lost."

```tsx
const { dirty, markSaved } = useDirtyBaseline(values, loaded); // or RHF isDirty
const guard = useUnsavedGuard(dirty && !busy, {
  message: "You have unsaved edits on this batch. Leave without saving?",
});
…
<FormActions guard={guard}>
  <Button tone="secondary" onClick={() => guard.confirmLeave(() => navigate("/batches"))}>
    Cancel
  </Button>
  <Button type="submit" busy={busy}>Save</Button>
</FormActions>
// after a successful save:
guard.proceed(() => navigate("/batches"));
```

What the person gets, the same on every form:

- **The bar.** `<FormActions guard>` shows the warning
  `Unsaved changes` pill on its left while dirty and pins itself to
  the bottom of the window, so Save stays in reach on long forms
  (`sticky` keeps it pinned while clean too — the daily book). A
  `note` prop holds the clean-state hint. Never hand-write the pill,
  a "you have unsaved edits" line, or a second save bar. On a phone
  the bar keeps clear of the round help button in the bottom-right
  corner, so the main button is never under it.
- **Leaving inside the app** — sidebar, breadcrumb, Cancel link,
  back button, `navigate()` — is held by the one router blocker in
  `components/UnsavedChangesHost.tsx` (needs the data router in
  `main.tsx`) and confirmed with "Discard unsaved changes? — Keep
  editing / Leave". Only a change of page counts: a query-string
  change on the same page (a tab, a list's filters or page) keeps the
  form mounted and goes through. When the query names WHAT is being
  edited (the daily book's `?date=`), step it with
  `guard.confirmLeave`.
- **Refresh, tab close, typed URL** — the browser's own "Leave
  site?" prompt (`beforeunload`; browsers do not allow custom text).
- **The form's own Cancel / Back** goes through
  `guard.confirmLeave(fn)`, which also covers leaves that are not a
  route change (closing an inline form).

Rules:

- `dirty` means "differs from the last saved values", never "the
  person touched a field". `useDirtyBaseline(values, ready)` for
  useState forms — `ready` turns true only once the loaded values
  are in state (a `hydrated` flag set in the hydrate effect), and
  `markSaved()` after a save that stays on the page.
  react-hook-form forms pass `isDirty`.
- Gate on `&& !busy` so a save in flight never prompts, and wrap the
  post-save navigation in `guard.proceed(...)`.
- Sign-out never prompts (the session is already gone).
- Not guarded: sign-in / sign-up / password / 2FA screens, forms
  inside a `<Modal>` (closing one is explicit), autosave pages (the
  store daily book saves on blur), single-field row editors with
  their own Save (lottery counts, pay rate), and pick-then-push
  tools that hold no typed data (bulk permissions).
- `lib/sourceGuards.test.ts` fails on a `beforeunload` listener or
  an "Unsaved changes" label written outside the guard.

## 3. Status display

Pill tones carry ONE meaning each — the same status kind gets the
same tone on every screen:

| Semantic | Tone | Cell text |
|---|---|---|
| Live state: active / on / enabled / in-progress | `accent` | `Active` |
| Completed outcome: approved / settled / delivered / cleared / credited / resolved | `success` | — |
| Inactive / off / disabled / archived — NOT red; red is for failures | `neutral` | `Inactive` |
| Pending / expiring / needs attention | `warning` | — |
| Failed / rejected / cancelled / destructive | `negative` | — |
| Informational / secondary identity (owner role, info) | `info` | — |

- Boolean table cells: `Active` / `Inactive` (lifecycle) — never
  `Yes`/`No`, `Disabled`, `✓`, or `—` — except dense matrices, where
  `✓` / `—` is the standard pair.
- Role pills: `admin → accent`, `employee → neutral`, `owner → info`,
  `accountant → info` (a secondary, view-only identity);
  the platform roles `superadmin → warning`, `support → info` (never
  red — no role is a failure). One map: `ROLE_TONES` / `roleTone()`
  in `api/roles.ts`.
- Plan pills: `basic`/`pro → accent` (paying = live), `trial →
  warning`, `inactive → neutral`. One map: `PLAN_TONES` /
  `planTone()` in `api/billing.ts`.
- Tone maps shared by 2+ routes live in the API layer next to the
  type (see `TICKET_STATUS_TONES` in `api/support.ts`), not copied
  per route.

### Breakdown pills — the parts of a figure

When a total is made of parts (Cash / Check, Taxable / Non-taxable /
Sales tax, one per service), show the parts under it with
`<BreakdownPills parts={[{ label, amount, open? }]}>`: one small pill
per part, stacked in a column, the size of a status `<Pill>`, money via
`fmtMoney2`. Never a "Cash $X · Check $Y" text line, and never a list of
names without amounts.

- The colour is the part's **position** (`--db-series-1..5`), not a
  status. Status stays on `<Pill>` tones, beside the name.
- A part at zero **fades**, it is never hidden, so cards in a row keep
  their shape.
- `open: true` is money still outstanding and NOT in the total (owed
  to the store, checks on hold): it renders outlined.

### Daily book boxes

Every box on the MSB daily book is a `<DailyBookTile>`
(`routes/DailyBookTile.tsx`): name, status pills beside the name, the
total, `<BreakdownPills>`. A box that holds more than one kind of thing
opens to `<BoxTabs>` — the kit's `TabsBar` / `TabsButton` with each tab
reading "Label · $amount" and the `(i)` tip for the active tab. Money
still owed lives on a tab of the box it comes back through (Owed to us
on Cash In, We owe on Cash Out, On hold on Check Deposits), never as a
box of its own. The one status pill for open money is
`<OpenStatusPill>`: red "N overdue" if any is overdue, else amber
"N open" / "N on hold". New daily book work starts from these.

A figure never leaves its box, at any window width. The tile header is
a two-column grid: the total keeps its own `auto` column on the right
and the name takes `minmax(0, 1fr)`, so a long name wraps and the
status pills drop under it. Any card that puts a name beside an amount
follows the same rule: the amount `white-space: nowrap`, the name
column allowed to shrink (`min-width: 0`) and wrap.

A period stepper never moves while you step. Its place must not depend
on anything that changes as the day changes (a Saved or Locked pill,
Lock ↔ Unlock). In a toolbar with things on both sides it sits in the
middle of a `minmax(0, 1fr) auto minmax(0, 1fr)` grid (the day book
toolbar from 78rem up, below); in a flush-right header the button
after it keeps one width for every label.

### Day books — one frame

The MSB daily book and the store daily book are the same kind of page
and wear the same frame, `components/DayBookChrome.tsx` (it replaced
the store daily book's own header, totals strip and "Back to the
month" button, and the copies inside `EditDailyBook.tsx`). Owner,
2026-11-22.

- `<DayToolbar>`: sticky; the trail on the left, the kit
  `PeriodStepper` (`variant="chevrons"`, `arrowKeys`, `onCalendar` back
  to the month) with a `<DayStepLabel>` dead centre, and on the right
  `<OverShortReadout>`, one pill (Locked · when, else Saved · when) and
  `<LockButton>`. It stays on screen while a day loads.
- `<ColumnHeader>`: one per column, sticky under the toolbar (not on a
  phone), a 3px stripe on top and the column's total in mono. Stripe
  tones: `accent` money in, `negative` money out (the only tone that
  also colours the total), `info` and `neutral` for columns that are
  neither.
- A day book with many plain lines (the store daily book) is a ledger:
  ONE card per column, the line's name on the left and its box on the
  right so a column's money boxes share one edge, groups set apart by
  a hairline. A group's heading is left out when it would only repeat
  the name of its one line. In a column narrower than 20rem (a
  container query, not the window) the name goes above the box.
- A box that saves when you leave it saves only if it was typed in,
  shows "Saved · time" in the toolbar, and an answer from the server
  never replaces a box that is being typed in.

### A figure from the register under a line

Where a machine reported a figure for a line a person can also type
(the store daily book's register day close), the machine's figure
sits under the box, right-aligned with it, in mono 0.75rem:
"Register $1,031.07". While the box still holds it: the accent colour
and a tick. Once the box differs: the negative colour, a "not equal"
mark and a "Use" button that takes the figure back. The mark is an
`<svg role="img">` with a name ("Matches the register." / "Different
from the register.") and the caption is the box's `aria-describedby`,
so the meaning never rests on colour. $0.00 on both sides shows no
caption. Empty boxes are filled when the day opens; a number a person
typed is never replaced, on the page or on the server
(`api/Modules/StoreBook/CLAUDE.md`).

### Bank vs daily book — reconciled status

Whether bank money is already in the daily book shows the same way
on both sides (BankSync `INVARIANTS.md` → "Matching"):

- **Bank page**, "Daily book" column: one `<Pill>` per row through
  the `PILL` map in `routes/BankMatching.tsx` — `Matched` / `Added
  from bank` = `accent` (on the books), `Check match` = `warning`
  (a person decides), `Not on books` / `Dismissed` = `neutral`.
  Never a second map, never a coloured row background.
- **Daily book**, any entry the bank has: the `<InBankPill>`
  (`accent` "In bank", the bank date in its tooltip) in the entry's
  note cell. An entry the bank hasn't seen shows nothing.
- **Same money twice**: typing an amount the bank feed already added
  to that box asks first in a `ConfirmDialog` ("Already here from
  the bank?", "Add anyway" / "Don't add") — never a silent add, never
  a block.
- **Bank page tabs**: `To reconcile (N)` (the default, a plain
  `/bank-transactions` link opens it) · `Reconciled (N)` · `All`,
  the kit `TabsBar` / `TabsButton` above the table, tab in the URL
  (`?tab=`). The server decides which rows still need a person with
  ONE rule, `reconcile.to_reconcile_clauses`, the same one the bell's
  bank item counts, so the tab count and the bell always agree.
  Never a second "to review" / "uncategorized only" toggle beside it.
- "Is this already in the daily book?" is the one review popup
  (`MatchReviewModal`); Unmatch and Dismiss confirm with
  `confirmTone="danger"`; Dismiss buttons carry
  `perm="bank_dismiss.update"`.

## 4. Formatting

| Value | Formatter (`lib/formatters.ts`, `lib/datetime.ts`) | Never |
|---|---|---|
| Money | `fmtMoney2` (or `fmtMoney` for whole-dollar KPIs) | `` `$${x.toFixed(2)}` `` (drops thousands separators), private clones, inline `toLocaleString` |
| Timestamp | `formatTimestamp` (audit trails, logs; names the zone), `formatDateTime` (feeds, "locked at"), `formatTime` (time of day) | `toLocaleString()` / `toLocaleTimeString()` inline |
| Date | `formatDate`; `formatShortDate` in charts, `formatDateCompact` in dense tables, `formatDayLabel` for a day heading — a stored day (`send_date`, `paid_on`) too, in a cell and in a sentence | `.slice(0, 10)` (wrong calendar date for US stores on UTC timestamps), `toLocaleDateString()`, printing the raw `2026-11-14` |
| Comparing an API timestamp | `parseTimestamp` (reads the server's offset-less UTC strings as UTC) | `new Date(row.created_at)` (reads them as local time: off by the UTC offset) |
| A `datetime-local` input | `utcToZonedInput` to prefill, `zonedInputToUtcIso` to send | `new Date(value).toISOString()` (the device's clock, not the store's) |
| Counts | `fmtNumber`; a count with its noun (list subtitles, "N results") through `fmtCount(n, "transfer")` / `fmtCount(n, "person", "people")` | bare `.toLocaleString()`, a hand-written `n === 1 ? "x" : "xs"` |
| Today / a day N ago / a month start as `YYYY-MM-DD` | `todayIso`, `daysAgoIso`, `monthStartIso` (the store's day); `storeNow()` for "this month / week" math; `toIsoDate` only for a Date built from calendar fields | `toISOString().slice(0, 10)` (the UTC day: tomorrow for a US store after ~7pm), `new Date()` for the current day or month, per-route `todayIso` copies |
| Month names | `MONTH_NAMES` / `MONTH_NAMES_SHORT` | a per-route array |

**Every date and time renders in the store's timezone** (Settings →
General). The shell sets it once from session-status
(`DisplayTimezone` in `AppShell`); the helpers above read it, so a
page never fetches or passes a timezone. With none saved, the device's
zone is used. The server-side twin is `api.Core.Clock.local_today
(store.timezone)` — never `date.today()` in a store-scoped route.

`src/lib/sourceGuards.test.ts` fails on the banned patterns in
this table and on a hand-written API-error toast (use
`useApiErrorToast(err, "fallback")`).

## 5. Overlay & interaction behavior — headless primitives, never hand-rolled

Anything with open/close/dismiss/focus behavior is built on a
headless primitive INSIDE the kit — we style it; we never
re-implement outside-click, Escape handling, focus trapping, or
keyboard navigation ourselves (that's where a11y bugs breed):

| Behavior | Base | Kit surface |
|---|---|---|
| Modal / confirm | `@radix-ui/react-dialog` | `<Modal>` / `<ConfirmDialog>` |
| Bottom sheet (mobile row actions) | Radix Dialog | `<RowActions>` |
| Dropdown / popover menu | `@radix-ui/react-dropdown-menu` | `UserMenu` (pattern) |
| Tooltip | `@radix-ui/react-tooltip` | `<Tooltip>` / `<InfoTip>` |
| Command palette | `cmdk` | `CommandPalette` |
| Date picker | `react-day-picker` | `<DateInput>` / `<DateRangePicker>` (one calendar look: `ui/dayPicker.css`) |
| Type-ahead list under a field | `@radix-ui/react-popover` (portal) | `SenderAutocomplete` (pattern) |
| Form boolean controls | **native `<input>`** (deliberate — best form-library + a11y compat; do NOT swap for Radix Switch/Checkbox) | `<Checkbox>` / `<Switch>` |

Anything that opens OVER the page (a calendar, a type-ahead list) renders
in a portal, never as an absolutely positioned child: a later card on
the form paints over a child, and a Modal body clips it (the date field
in #935, the sender's customer list on 2026-10-13).

Routes never import `@radix-ui/*` directly — they use the kit
component. Need a new overlay kind? Add the Radix-based primitive
to the kit first, styled with `--db-*` tokens and the `.ds-popover`
motion class, then use it.

## 6. Reuse before you build — MANDATORY

**Before writing any component, hook, helper or CSS block, check
whether one already exists.** This is a gate, not a suggestion:
every duplicate is a second place to fix the same bug, and we have
already paid for that twice (see below).

The check, in order:

1. **`frontend/src/components/ui/index.tsx`** — the kit's export
   list is the inventory. Read it. It is short on purpose.
2. **`grep` for the concept**, not the name you'd have chosen.
   Looking for a calendar? `grep -rn "grid-template-columns:
   repeat(7"`. A money field? `grep -rn "MoneyInput"`. The thing
   you want often exists under a name you didn't guess.
3. **Look at the nearest existing page that does the same job.**
   Building a daily sheet? The MSB daily book already is one.
   Building a list with filters? Transfers is the reference.

**Two copies is the extraction threshold.** If you are about to
write something a second time, extract it first and move the
existing caller onto it in the SAME PR. Extracting for the new
page only, and leaving the old copy alone, doubles the maintenance
instead of halving it — the point is fewer implementations, not
more abstractions.

**When you extract, take the hard-won details with you.** A
component earns its keep by carrying the fixes that are easy to
forget: containment rules, accessibility labels, edge-case
handling. Put a comment on them saying *why* they exist, so the
next person doesn't "simplify" them away.

Known shared components, and what they own:

| Use this | Instead of |
|---|---|
| `MonthCalendar` + `MonthCalendarLegend` | a month grid, cell states, money/variance containment |
| `PeriodStepper` (+ `shiftMonth` / `addDaysIso` / `mondayOfIso` / `monthRangeIso` / `formatWeekRange` in `lib/datetime`) | a ← / label / → day, week or month bar, its "Previous month" labels, "Today" button, ← / → key handling, or your own month/week arithmetic |
| `BulkResultsCard` + `useStoreSelection` + `StoreChecklist` (owner bulk actions) | a per-store Store / Status / Notes results table with its own status → pill map, or a hand-rolled "Select all / N of M selected" store picker |
| `ReportCenterPage` (`components/ReportCenter.tsx`) | a reports landing page with its own list fetch, scope message and load-error card — Reports, owner Reports and Platform reports are one page with three lists |
| `AuditFilterFields` (`components/AuditFilterFields.tsx`) | your own Target / Action selects above an `AuditTable` |
| `DeskNoStore` (`components/DeskPage.tsx`) | a check cashing page's own "sign in to a store" frame |
| `CheckPartyList` (`components/CheckPartyList.tsx`) | a check cashing customer / company list page with its own status tabs, search and CSV wiring |
| `describeAppliedRule` (`lib/bankRules`) | your own "N tagged, N booked, N skipped (day locked)" toast text |
| `BankCategoryCell` + `BankRuleFromRow` (`components/`) | a bank row's own category dropdown, "Change day" / locked-day recovery, double-count question ("Is it the same money as…") or "Make a rule" popup — the Bank transactions page and the Monthly P&L's Transactions tab render the same two |
| `TransferForm` (`components/TransferForm.tsx`, schema + starting values in `lib/transferForm.ts`) | a new or edit money transfer page with its own fields, company / country lists, employee picker, payout / debit card rules or save flow — New transfer and Edit transfer both render it and keep only their title, trail and save call (they were two copies that drifted: Edit had no "(USD)" on the amounts and no roster error, New had no "(former)" employee) |
| `MoneyInput` | `<input type="number">` + your own cents parsing |
| `PartyNameInput` (`components/PartyNameInput.tsx`) | a plain text box for a returned check's company or customer — it suggests the names the store already used (a native `<datalist>`, never clipped) so the same party is typed the same way and the By company / By customer counts add up |
| `DataTable` (+ `useUrlFilterState({ pageSizeKey, defaultSort })`) | any list page's `<table>`, header row, loading / empty / error states, clickable `<tr onClick>`, sort buttons, or `<Pager>` wiring — see "Lists" in §7 |
| `DataTable` `exportCsv` (+ `csv` on columns, `lib/csv.ts`) | a page-local "Export CSV" button, a hand-built CSV string, `toFixed(2)` money or a `formatDate` cell in a file — see "Export" in §7 |
| `.ds-input-row` (kit class, `ui.css`; `--end` when the field has a label above it) | an inline `style={{ display: "flex" }}` row of a field and its button ("Detect from address", "Link store") — it never wrapped, so on a phone the button left the card |
| `pageOf` / `sortRows` (`lib/pagination`) | slicing or sorting a whole list in the browser by hand |
| `Table`, `TableStates` | small tables inside a form or box (receipt lines, the daily-book boxes) — not list pages |
| `PermissionMatrixTable` | a per-route permission grid |
| `RolePermissionsEditor` (`components/RolePermissionsEditor.tsx`) | a page that loads, edits, saves or resets a set of roles' grids — Platform → Permissions, an owner's store permissions and the superadmin store page all render it; give it the endpoint and it brings the grouped grid, the "All" column, "Customized" / "View only" labels, the unsaved-changes bar, a save of only the roles that changed, and the confirmed "Reset to defaults" |
| `RolePill` (`components/RolePill.tsx`), `roleLabel` (`api/roles.ts`) | `<Pill tone={roleTone(r)}>{r}</Pill>` (it printed "owner" in lower case), a page-local `{ admin: "Admin", … }` map or an inline role-name ternary |
| `RowActions` | inline row buttons (it handles the mobile sheet) |
| `TabsBar` / `TabsLink` / `TabsButton` | a hand-built tab strip |
| `ConfirmDialog` | `window.confirm` |
| `ModalActions` | a `.modalActions` CSS class or an inline right-aligned button row inside a popup |
| `PageCrumbs` (`components/PageCrumbs.tsx`) | a hand-typed `<Breadcrumbs crumbs={[…]}>` trail |
| `fmtCount` (`lib/formatters`) | `` `${n.toLocaleString()} ${n === 1 ? "x" : "xs"}` `` |
| `useUnsavedGuard` / `useDirtyBaseline` + `<FormActions guard>` | your own `beforeunload`, "Unsaved changes" label, leave-confirm dialog, baseline-vs-draft compare, or save bar — see "Unsaved changes" in §2 |
| `CountBadge` (kit) | a page-local red count circle, an `UnreadBadge`, or a badge that sits in the flow and widens its button — it is drawn on top of its parent so the control never changes size, hides at 0 and caps at `max` ("99+", "9+") |
| `NotificationBell` (`components/NotificationBell.tsx`) + `BELL_ITEMS` (`lib/bellItems.ts`) | a new top-bar banner, chip or badge that tells someone there is work to do — add a bell item instead (§11) |
| `toast({ …, action: { label: "Undo", onClick } })` | a hand-built "Undo" link inside a toast message |
| `useApiErrorToast` | `toast({ message: err instanceof ApiError ? … , tone: "error" })` |
| `*_STATUS_TONES` in `api/` (`BATCH_`, `TRANSFER_`, `RETURN_CHECK_`, `TICKET_`) | a per-route status → tone map |
| `fmtMoney2` / `formatDate` / `formatTimestamp` | `toFixed(2)`, `.slice(0, 10)`, `toLocaleDateString()` |
| `Modal`, `Tooltip`, `Switch`, `Checkbox`, `Pill` | hand-rolled equivalents |
| `KpiCard` / `KpiGrid` (`colorValue` to paint a signal figure in its tone) | a page-local stat tile, `StatRow`, or `.kpi*` / `.summaryTile` CSS |
| `CopyField` / `CopyButton` | a read-only `<input>` + Copy button with its own `navigator.clipboard.writeText` (it owns the execCommand fallback, the "Copied" flash and the failure toast) |
| `Barcode` (kit; encoder `lib/code128`) | a page-drawn barcode, or an image from a barcode service, for a code someone scans into another program (DineroBook Manager's connect code) — Code 128, dark on `--db-paper` in both themes, with its quiet zone |
| `AuditTable` (`who="store"` for one person's cross-store feed) | a per-page audit `<table>` of When / Actor / Action / Target / Details |
| `BreakdownPills` | a "Cash $X · Check $Y" line, or per-card part chips |
| `DailyBookTile` / `BoxTabs` (daily book) | a hand-built box button or a tab strip with its own "Label · $X" + tip row |

The same rule applies on the backend: a Service that two modules
need lives in `api/Core/` or the owning module's `Services/`, not
copy-pasted. `PLAN_CATALOG` exists because plan prices had been
duplicated into three modules and two had silently drifted.

**Cautionary tale, so this isn't abstract.** The Store Daily Book
shipped with its own month calendar — the same grid maths, the
same cell states, and a hand-copied version of the containment
rules that fix a real overflow bug. It also used raw number inputs
instead of `MoneyInput`. Consolidating took 933 lines across two
implementations down to 843 across one, and cut one page's
stylesheet from 137 lines to 12. None of that work would have been
needed if the kit had been checked first.

## 7. Layout & styling (recap — details in CLAUDE.md)

- Kit primitives first; page-specific leftovers in a co-located
  `<Route>.module.css`. No bottom-of-file `CSSProperties` constants,
  no large inline `style={{…}}` blocks.
- A link nobody styled is the accent (`:where(a)` in `styles.css`),
  never the browser's blue / purple. Two cards in one form are spaced
  by the form (`className="ds-form"`), two `<Section>`s in one card
  get a hairline between them, and a `<SectionTitle>` that opens a
  card has its own space under it — never a hand-added margin.
- No colour literal anywhere in `frontend/src` — no hex, no `rgb()`,
  no `var(--db-x, #fallback)`. Every colour is a `--db-*` token from
  `static/design-tokens.css` (or `tokens.*` in TSX). A colour you
  need that is not there gets a token, with its light-mode value in
  the `[data-theme="light"]` block, or is listed there as
  theme-fixed (brand mark, referral gold, paper) with a reason.
  Shadows, scrims and the sticky top-bar glass are tokens too
  (`--db-shadow-pop`, `--db-shadow-modal`, `--db-scrim`,
  `--db-nav-glass`). `tests/test_theme_tokens.py` fails on a
  literal, a fallback, an undeclared variable, a colour token with
  no light value, or a stylesheet under `static/` that no page
  links.
- Tables: kit `<Table>`; the permission matrix uses the shared
  matrix component, not a per-route copy. A `<Table>` cell left bare
  still gets the kit padding, edge and header type (`:where()` rules
  in `Table.module.css`), so `thStyle` / `tdStyle` are for overriding,
  not for making a table readable.
- **Lists.** Every list page is a `<DataTable>`, so every list in
  the app behaves the same:
  - **Row count, always.** `page={{ page, totalPages, total, onPage,
    perPage, onPerPage }}` renders the shared `<Pager>`: "Showing
    a–b of N" even on one page, Prev / Next only when there is more
    than one, and the 25 / 50 / 100 rows-per-page picker once the
    list is longer than 25.
  - **Paging state in the URL.** `useUrlFilterState(defaults,
    { pageSizeKey: "<list>" })` keeps `page` (and filters) in the URL
    and remembers rows per page per list (`db.page_size.<list>` in
    local storage, guarded). Changing filters or rows per page goes
    back to page 1. Never keep the page in `useState`.
  - **Sort on the server.** A column with `sortKey` becomes a sort
    button (`aria-sort`, flips on a second click, `sortFirst: "desc"`
    for dates and money). `defaultSort` puts `sort` / `dir` in the
    URL; the endpoint takes them and maps the slug through a
    whitelist with `api.Core.Sorting.order_by_slug` (unknown slug =
    the default order, `dir` validated by `SORT_DIR_PATTERN`). A
    list the server sends whole for other reasons (a store's
    employees, read by pickers too) sorts and pages with `sortRows`
    / `pageOf` instead.
  - **Money stays on one line.** A column with `align: "right"`
    (money, counts) never wraps on a desktop table: "$18,003.00"
    broke into "$18,003" / ".00". The table scrolls inside its box
    instead; phone cards may wrap again.
  - **Paged endpoints stay backwards compatible.** Adding paging to
    an endpoint other pages already read: `page` optional — no
    `page`, every row plus `total`; with it, the `api.Core.Pagination`
    envelope. Feeds merged from two tables page with
    `paginate_merged`, never "newest 500 then slice".
  - **Rows open by keyboard.** `onRowClick` + `rowLabel` make the row
    a button (Enter / Space). A button or link inside the row keeps
    its own job. `expandedRow` opens a panel under the row (a
    ticket's conversation). Only give a row `onRowClick` when the
    viewer may open what it leads to.
  - **Pinned header, phone cards.** The header stays put while the
    list scrolls; under 36rem each row becomes a card of
    "label  value" lines (`label` on a column whose header is not
    plain text, `""` to hide it). Do not wrap a DataTable in an
    `overflowX: auto` div.
  - **Export.** A list whose rows someone would take to a
    spreadsheet or an accountant gets `exportCsv` — never a page's
    own CSV button. Give each data column a `csv` value (money as
    `csvMoney`, dates as `csvTimestamp` / `csvDate`, words for
    pills), `extraColumns` for parts a cell packs together (a
    transfer's fee and tax behind its total), and either
    `fetchPage` (the SAME request the list makes, from a shared
    `fetchXPage` in `api/`) or `allRows` (a list the browser holds
    whole, sorted, before `pageOf`). The kit then puts "Export CSV"
    above the table and writes every row the current search,
    filters and sort match — not just the page on screen — in the
    store's timezone, headed in the person's language, UTF-8 with
    a BOM, formulas defused, capped at 10,000 rows with a "narrow
    the list" toast. The button needs `reports.read` (the Data
    export page's right) unless the list names its own `perm`.
    Action-only lists (sessions, discounts, passkeys) and the
    customer directory (its own server export, `customers.update`)
    have none. Server CSVs defuse formulas the same way
    (`api/Core/Csv.py` `safe_cell`).
  - **Filter bar — one row of list tools.** A list's search,
    filters and the table's own actions sit on ONE row, the way
    premium dashboards do it (researched live, 2026-11-20: Vuexy's
    user list, shadcn-admin's tasks): search first, then the
    filters, then the actions on the right. The kit class is
    `ds-filter-bar` (`components/ui/ui.css`): flex, wraps only when
    the window is too narrow, the search takes the spare room up to
    a readable 26rem, every other control keeps a compact 10rem,
    `ds-filter-bar__end` sits on the right (a count, Export CSV) and
    `ds-filter-bar__note` is a short status ("Updating…"); on a
    phone the search takes the row and the filters pair up. A list
    with a `<DataTable>` passes its controls as `toolbar` — the
    table renders them in that row beside Export CSV and keeps them
    while the list loads or comes back empty, so a search that
    matched nothing can be changed. A bar that scopes KPIs above
    the table (Transactions, Item movement) stays a plain
    `<div className="ds-filter-bar">` over them, and a list without
    a table uses the div or `<Card className="ds-filter-bar">`.
    Never a page's own toolbar CSS, a fixed-column grid, an inline
    width on the search box, or filters up in the page header. The
    page header keeps its actions on the title's row: the title
    takes the spare room and a long subtitle wraps inside it. A
    page's own buttons ("Add support login", "+ New transfer") go in
    `PageHeader actions`, never in a row of their own under it.
  - **Import.** A file from another system (a Modisoft price book
    or department list) takes two steps: a **check** that writes
    nothing and shows what would happen (new, updated, already up
    to date, skipped and why, the lines it could not read), then
    **Import**. The server reads an .xlsx through `api/Core/Xlsx.py`
    and finds columns by name, never by position, so a store's
    re-ordered export still works; a re-import never doubles a row.
    A value that needs a person's decision (a Modisoft Lottery or
    Services department's exact type, owner 2026-11-19) is marked in
    the check's review table and decided there, before anything is
    saved — never stored as a guess to fix afterwards. Examples:
    `routes/ModisoftImportModal.tsx`,
    `components/DepartmentImportModal.tsx`.
  - **Every list is a DataTable**, including a short one inside a
    settings page (referrals, sign-in sessions, invite codes) or
    one table per group (Payroll's per-person shifts, with the
    change log as `expandedRow`). Only a table that is part of a
    form or a report layout (daily book boxes, P&L lines, the
    permission grid, receipts) keeps the bare `<Table>`.
  - **Register receipts — one renderer, beside the list.** A register
    ticket is drawn by ONE component, `components/Receipt.tsx`
    (researched 2026-11-20 against the owner's other back offices,
    Cronysoft's receipts and Modisoft's item report): ink on white
    in both themes (`--db-paper-*`), like the till slip — the store,
    the time, ticket, register and cashier (by the name the store
    gave the number, `cashierLabel`), every line with its scan code
    and department, the regular price in `--db-paper-flag` when the
    register sold below it, voided lines struck through in
    `--db-paper-void` at the price they rang and never added, then
    the totals and how it was paid (`tenderLabel`). A no-sale or a
    register open / close prints what happened instead of lines.
    Both Transactions views (Receipts, and Items — every line sold,
    Modisoft's item report) open it BESIDE the list: `<ReceiptSplit>`
    with `useOpenReceipt()` (`lib/useOpenReceipt.ts`) — the chosen
    ticket's rows marked, its id in the URL as `ticket` so the list
    keeps its page and a link reopens it; on a window narrower than
    1100px a row opens the ticket's own page, which draws the same
    receipt with its register facts beside it.
    The kinds a manager hunts for (refunds, voided tickets, tickets
    with a voided item, drawer opens with no sale) are tabs with
    their counts over the list, the bank page's pattern. Never a
    second receipt layout or a page's own receipt table.
- A permission that is one on/off switch rather than an area (e.g.
  "Lock / unlock days") is a single-switch resource: listed in
  `RESOURCE_ACTIONS` (`lib/permissions.ts`) and the server's
  `RBAC_RESOURCE_ACTIONS`, it renders one box in the grid and never
  implies View. Don't model a switch as a whole create/view/edit/
  delete row.
- Access is managed by ROLE, on Team → Roles & access
  (`/team/roles`). A person's login form picks a role and shows a
  one-line summary; the resources × actions grid renders there only
  for "Custom for this person only". Never put a role's full grid
  back on a per-person page: it grows a row with every area.
- Steppers (prev/next day/month) and other widgets used by 2+ routes
  get extracted to the kit — two copies is the threshold.

## 7a. Logged-out pages — one chrome

Every page a person sees before signing in (sign-in, per-store
sign-in, 2FA verify / recover / enrol, sign-up, owner sign-up,
forgot / reset password) renders inside `AuthChrome`
(`frontend/src/components/AuthChrome.tsx`) and takes its layout
from `routes/auth.module.css`. That is the whole standard:

- **No page-local shell.** Not a split-screen variant, not an
  inline `<style>` block, not a second stylesheet with its own
  breakpoints. There used to be three shells; the one that was
  not this file is the one that overflowed on phones.
- **Card contents are kit primitives** (`Field`, `Input`, `Button`,
  `Alert`, `Pill`) inside `styles.stack`. Headings use
  `cardTitle` / `cardSub`; secondary links use `centerRow`; the
  footer uses `footer` / `copyright`.
- **Phones are the first target.** The card top-aligns under 600px
  so the keyboard does not shove it around, inputs are 16px on
  narrow viewports so iOS does not zoom, and everything under
  `.page` is border-box. When you touch this chrome, load the
  built SPA at 390px wide and check `document.documentElement.
  scrollWidth === clientWidth` before you call it done.
- **Marketing lives on the landing page,** not in the sign-in
  chrome. No testimonials, illustrations or uptime badges beside
  the password field.

## 7b. Names, the trail and wording — one name per page

Set by the 2026-10-21 consistency sweep; `src/lib/consistencyGuards.test.ts`
fails on each rule below.

- **Sentence case everywhere.** Page titles, sidebar sections and
  items, buttons, field labels, table headers, KPI labels, report
  cards and report columns: only the first word and proper nouns
  (MSB, ACH, P&L, TV, Intermex, Stripe…) start with a capital —
  "Edit employee", "Bank accounts", "Total sent", never "Edit
  Employee". The server's report card names
  (`api/Modules/Reports/Services/categories.py`) follow the same
  rule (`test_every_report_card_label_is_sentence_case`).
- **One name per page.** A page in the sidebar is titled exactly its
  sidebar label (`NAV` in `components/navConfig.tsx`), and a report
  page is titled exactly its card in the report center. Renaming a
  page means renaming the sidebar item (or card) in the same change.
  The guard checks every sidebar item against its page's title.
- **The trail comes from the sidebar.** Every page under the shell
  renders `<PageCrumbs />` above its `PageHeader` (dashboards, hubs
  and the subscribe flow excepted). Its first crumbs are the
  sidebar section (linked to its hub) and the sidebar item, never
  typed by hand:
  - a sidebar page: `<PageCrumbs />`;
  - a page under one (`/transfers/12`): `<PageCrumbs current="Transfer #12" />`;
  - a page the sidebar does not list: `<PageCrumbs under="/reports"
    via={[{ label: "Monthly P&L", to: "/monthly" }]} current="Edit" />`.

  The trail replaces "← Back to …" links at the top of a page.
- **One name per role.** A built-in role is named by `roleLabel()`
  (`api/roles.ts`) and shown as `<RolePill>` on every screen — "Admin", "Employee", "Owner",
  "Superadmin", "Support"; never a page-local map. A store admin is
  "Admin", never "Super Admin" (owner, 2026-10-21) — "Superadmin" is
  only the platform role.
- **Wording.** "Sign in" / "Sign out", never "Log in" / "Log out". The
  page's create button reads "+ New <thing>" (a record you start) or
  "+ Add <thing>" (something you put on a list), and the submit
  button inside the form says what it does ("Create rule", "Add
  invoice", "Save changes").
- **The phone top bar never widens the page.** The shell's single
  column is `minmax(0, 1fr)`; in the top bar only the store name
  shrinks (with an ellipsis) and the referral badge drops to its
  icon. Anything added to the bar must fit a 360px screen beside
  the menu button, the store name, the trial chip, the theme
  toggle and the avatar.

## 8. Access — no access, no control

If a person cannot open a page, they must not see the tab, link,
button or row action that leads there. Not an empty tab, not a
button that bounces to the dashboard, not a dropdown that 403s on
change. The control disappears.

This is enforced by the kit, not by per-page checks:

- **Route access lives in ONE table**: `frontend/src/lib/access.ts`
  (`ROUTE_ACCESS`). Every authed route in `App.tsx` is wrapped in
  `<Gate>`, which reads it. `access.test.ts` walks `App.tsx` and
  fails when a route has no entry — a new page cannot ship
  unmapped.
- **Links hide themselves.** `ButtonLink`, `TabsLink` and `AppLink`
  render nothing when `canAccess(to)` is false (an in-app `href` is
  checked the same way). Use `AppLink` instead of React Router's
  `Link` inside the shell; `fallback="text"` keeps the words for a
  link inside a sentence.
- **Sidebar and section hubs** derive visibility from the same table
  (`filterNavForRole`). Nav items carry `roles` and `flag` only —
  never a duplicated `perm`.
- **A group only for a superadmin inside a store** (owner, 2026-11-20):
  **Developer** carries `impersonation: true` in `NAV` and shows only
  while a superadmin is signed in AS the store (`session-status.
  impersonation`). The store's own people never see it; its pages send
  them home and the server refuses them (`api/Modules/Developer`). Such a
  group is read only, so it works on a read-only impersonation.
- **A store's work is grouped by business** (owner, 2026-11-19): **MSB**
  (money services: MSB daily book, transfers, customers, ACH batches,
  returned checks, the check cashing link, MSB reports, check cashing
  report) and **Retail** (convenience store / gas station: store daily
  book, transactions, lottery, price book, purchases, store reports).
  Each business carries its own report center; the **Reports** group
  is the accountant's menu (Monthly P&L, Data export). A group shows
  only what the store's module switches turn on, so a pure
  money-services store never sees Retail and a gas station's MSB holds
  only its check work. A renamed group keeps its old `/hub/<slug>`
  link working (`RENAMED_SECTIONS` in `routes/SectionHub.tsx`).
- **A module still being built** sits behind an opt-in store switch
  (`OPT_IN_NAV_FLAG_KEYS`, e.g. check cashing's `check_desk`): no
  store sees it until a superadmin turns it on, and no other page
  links to it until it is finished.
- **A separate app inside DineroBook** (check cashing: a product a
  store buys on its own, like the competitors sell it) is a *view*,
  not a sidebar group. A "Back office | Check cashing" switch in the
  top bar (at the top of the drawer on a phone) swaps the whole
  sidebar for the app's own (`CHECK_NAV`) and opens on the app's main
  job (check cashing: Cash a check), never on a hub of tiles: the
  first sidebar entry is that page.
  The back office's MSB group carries ONE link into the app ("Check
  cashing", owner 2026-11-19), which opens it like the switch. The
  app's own pages never join `NAV`; that link is not back office work
  (`hasBackOffice`) and the command palette lists it once, with the
  app's pages.
  The URL decides the view; personal pages (profile, sessions,
  support) keep the last one. The switch shows only where the store
  has the app AND the person has back office rights too; someone with
  only the app's rights always lands in it and never sees the switch.
  Each person's last view is remembered on the device and the first
  page after sign-in opens there.
- **Check cashing is a desk program** (owner, 2026-11-09: "the full
  screen must be used at all times and no page scrolling … so it
  feels like a software"). Every check cashing page is a `DeskPage`
  (`components/DeskPage.tsx`), never `PageShell`: it fills the window
  and the window never scrolls (`.app-shell--desk .app-content` is
  `overflow: hidden`). Fixed parts (trail, header, the action bar)
  stay put; only boxes scroll inside themselves — `DeskPane` for one
  box that takes the room left, `DeskColumns` for side-by-side boxes,
  `DeskForm` for a form whose fields scroll above a fixed
  `FormActions` bar (it keeps the help bubble's corner free).
  The fixed parts never give height to the boxes: the frame keeps
  every direct child at `flex-shrink: 0` (a squeezed header painted
  its subtitle over the first box), and only `DeskPane` /
  `DeskColumns` / `DeskForm` or a page's own filling block shrink.
  Desktop only: under 1024 px wide
  (`useDeskScreen`) the frame shows "works on a desktop computer"
  instead of the page. It also works only on the store's one
  activated computer (CheckCashing INVARIANTS "One computer"); on any
  other browser the frame shows a lock screen where an Admin can
  activate this computer or move check cashing here (confirm popup),
  and a cashier is told to ask an Admin. `DeskPage.test.tsx` fails
  when a check cashing route skips the frame or the CSS loses the
  no-scroll rules.
- **Check cashing pictures** (check front/back, ID front/back, the
  customer's photo) go through ONE component pair in
  `components/CheckPictures.tsx`: `PictureSlot` (the saved picture
  plus Camera and File buttons, shown only to someone who may change
  it) and `PictureView` (a thumbnail that opens large in a popup).
  The webcam is the store PC's (`Permissions-Policy: camera=(self)`);
  the server re-encodes every picture, so the page sends what it has.
  A file becomes base64 through `fileToBase64` (`lib/files.ts`), and
  a picture or download is fetched through `fetchBlob` (`lib/api.ts`,
  same sign-in refresh as `api()`), never a page's own copy.
- **A taxpayer number (SSN / ITIN)** shows masked (`•••-••-1234`)
  through ONE component, `TinValue` (`components/CtrDetails.tsx`):
  a manager's Show button asks the server (a POST, audited every
  time) and the number stays on screen only until the page closes.
  It is typed in a password box with autocomplete off, an empty box
  keeps the number on file, and it never goes into a table column, a
  CSV or a toast. A customer's CTR details are edited in ONE popup,
  `CtrDetailsDialog`, from the profile and from Cash a check alike.
- **The scanner is the default on Cash a check** (owner, 2026-11-11:
  cashiers know "open the program, hit Enter"). `CheckScanBar`
  (`components/CheckScanBar.tsx`) is the one way numbers get in: in
  the Check Desk Windows app it opens with "Scan check" focused and
  Enter scans; without a scanner the MICR line box has the focus and
  Enter fills the boxes (`lib/micr.ts` `parseMicrLine`, the one MICR
  parser). After a save or clear the focus returns there. Scanner
  messages go through `lib/scanner.ts` only.
- **Check cashing reports read from the back office.** The desk is the
  separate app on one computer; what owners and Admins read about it
  elsewhere is the back office "Check cashing report"
  (`routes/CashedChecksReport.tsx`, a normal `PageShell` page in the
  MSB group, phone friendly, view only). A period's totals are ONE
  component, `CheckTotalsGrid` (`components/CheckTotals.tsx`), on that
  report and on the desk's Checks page.
- **A bad check is one popup everywhere** (`components/BadCheck.tsx`).
  A manager marks a cashed check bad from its row in the recent checks
  (`ReportBadCheckDialog`, "Mark bad"); the row then carries a "Bad
  check · $X left" pill and "View bad check", which opens
  `BadCheckModal` — the same popup the Bad checks page opens from a
  row: what is owed, the payments, "Record payment" and the
  manager's "Write off" (a danger confirm that asks why). Status
  tones keep their one meaning: open = warning (money still owed),
  paid back = success, written off = negative.
- **In-page actions that are not links** declare what they need:
  `<Button perm="lottery.update">` and `RowActions` items with
  `perm: "users.update"` drop themselves. The value mirrors the
  `require_permission(...)` on the API route the click calls.
- **Roles are not permissions.** `identity.role === "admin"` as a
  show/hide condition is a change request: a custom access role
  (R-3) can grant or withhold any right, and a role check ignores
  it. Ask `hasPermission(resource, action)` or `canAccess(path)`.
- **A view-only role has a page list, not just permissions.** The
  Accountant (fixed access: Reports, monthly P&L, tax pack) may only
  open the pages in `ACCOUNTANT_PAGES` (`lib/access.ts`) — the SPA
  twin of the server's route list in
  `api/Core/Permissions/accountant.py`. `canAccessWith` checks it
  before the table, so an `open` page (dashboard, notifications,
  support) is closed to them unless listed, and a refused page sends
  them home with `homePathFor` (Reports for an accountant, the
  dashboard for everyone else). A page that shows several downloads
  hides each one the viewer's sign-in would be refused (Data export).
- **Money figures a role must not see never leave the server.**
  Hiding a tile in the SPA is not the gate: the dashboard builds a
  block only for the people allowed to see it and sends null (or no
  key) to everyone else, and the SPA renders the block only when it
  arrives. The Monthly P&L tile (`PLMonthTile`, first on the admin
  dashboard, owner 2026-11-27) is for store Admins who can read the
  P&L: never employees, custom roles, owners or accountants, even
  with report rights (`_pl_month_block` in the Dashboard controller).
- **One store switch.** Whoever may move between stores (an owner, or
  an accountant whose sign-in is linked to several stores) does it
  through the top-bar store chip and the shared Switch Store popup
  (`SwitchStoreModal`). The chip appears only when there is somewhere
  to go; controls a role cannot use (+ Add store, Owner overview) are
  hidden, and a switch lands on that person's home page
  (`homePathFor`).
- **Tests sign someone in.** `src/test/setup.ts` seeds a
  full-permission admin before every test, so an isolated component
  renders its controls. A test about a narrower person overwrites
  `db.identity` in its own `beforeEach`.

## 9. Enforcement

- PR review checklist: any `<select>` with 2 boolean-shaped options,
  any `window.confirm`, any `toFixed(2)` on money, any `.slice(0,10)`
  on a date is a change request. **So is a component that duplicates
  something in section 6's table.**
- When you fix a drift, fix ALL instances of that drift in the same
  PR — one pattern, everywhere, or the standard erodes again.
- **An app-wide consistency change is not done until it is written
  down.** Any PR that makes something the same across the software
  (one control, one bar, one message, one behaviour) adds or updates
  the rule in this file — and, when it is a rule every change must
  respect, a line in `CLAUDE.md` "Design system" — in the SAME PR,
  with the shared component to use and what it replaces. Where a
  grep can catch a relapse, add it to `lib/sourceGuards.test.ts`.
  Owner's standing rule (2026-10-21).

## 10. Language — English and Spanish

Set 2026-11-04 (Spanish in the app). Each person picks **English** or
**Español** under Settings → Profile; it is saved on their account
(`User.language`) and follows them to every device. Signed-out pages
carry an **EN | ES** switch (`LanguageSwitch` in `AuthChrome`),
remembered on that device. After sign-in a saved profile choice wins;
a person who never chose (NULL, answered as null) keeps what the
device shows, so pressing ES at sign-in carries on into the app.
**English is the default and never changes** for anyone who does not
pick Spanish; the browser's own language is not used.

- **Words come from the translator, never typed in a covered screen.**
  `const t = useT();` then `t("login.title")`. The English words live in
  `frontend/src/i18n/en.ts`, the Spanish in `frontend/src/i18n/es.ts`.
  `es.ts` is typed against `en.ts`, so a key missing in Spanish, or a
  typo in a key, fails `npm run build`. Keys are `<area>.<what>`;
  shared words (`common.cancel`, `common.loading`) are reused, not
  re-added per screen.
- **Placeholders, never glued pieces:** `t("pager.showing", { first,
  last, total })` with `{first}` in both languages. Word order differs
  between the two; `i18n.test.tsx` fails when the placeholders differ.
- **The sidebar** keeps `NAV` in English (it names URLs, page titles
  and the breadcrumb trail) and shows each title and label through
  `navWord()` (`frontend/src/i18n/navWords.ts`). A new NAV label needs
  its Spanish there; `navWords.test.tsx` fails otherwise.
- **Server messages** stay English on the wire. The few sentences a
  covered screen can receive are listed in
  `frontend/src/i18n/serverMessages.ts` and come back in Spanish
  through `apiErrorMessage`; anything unlisted shows the server's
  English as before. `tests/Modules/Auth/test_spa_server_messages.py`
  fails if the API stops sending a listed sentence.
- **Dates** use the person's language for month and weekday words
  through the shared formatters (§4); the store-timezone rule is
  unchanged. **Money keeps US punctuation** ($1,234.56) in both
  languages, so amounts match receipts and bank statements. Never pass
  a locale to `Intl` in a screen.
- **Names stay as typed:** store, company (Intermex, Maxi, Barri),
  customer and employee names, and anything a person entered, are never
  translated. Each language's own name ("English", "Español") is shown
  untranslated so a person can always find theirs.
- **Covered screens are listed** in `COVERED_FILES`
  (`frontend/src/i18n/coverage.test.ts`). That guard fails when a
  covered file gains English typed directly in JSX text, in a `label`,
  `placeholder`, `title` or `aria-label`, or in an error setter.
  Moving a screen into Spanish = translate it, add a Spanish render
  test using `englishLeftovers()` (`frontend/src/test/i18n.ts`), and
  add the file to the list. A covered file never goes back.
- **Tests stay in English.** `src/test/setup.ts` resets the language to
  English after every test; existing tests find English text, which is
  the proof English did not change. A Spanish test sets
  `setLanguage("es")` itself.
- **Counts use `tn()`**, never `count === 1 ? "entry" : "entries"`:
  `tn("daily.entries", n, fmtNumber)` picks the `.one` / `.other` key
  by the language's plural rules ("1 entrada", "3 entradas").
- **Config tables hold keys, not words.** A table of boxes, tabs or
  columns (`SERVICE_KINDS`, `DAILY_TAB_DEFS`, the money-owed
  `DIRECTION` table) types its `label` as `MessageKey` and the screen
  renders `t(label)`. The coverage guard accepts a `label:` only when
  it is a real key.
- **Kit components translate their own words** (MonthCalendar's
  weekdays and legend, PeriodStepper's "Previous day", the confirm
  buttons), so every page that uses them is covered at once. Month
  headings use `formatMonthYear()`, weekday headings
  `weekdayNamesShort()` (`lib/datetime.ts`), never the English
  `MONTH_NAMES` arrays in a covered screen. A full weekday name is
  `weekdayNameLong(dayIndex)` (Monday = 0) and a month on its own
  `monthName(month, "long" | "short")`.
- **Markup inside a sentence uses `tNodes()`**:
  `tNodes("customer.selectedOne", { winner: <strong>{name}</strong> })`
  keeps the sentence whole in each language and styles only the
  piece, instead of gluing "Selected: " + `<strong>` + " (winner)".
  A sentence whose wording changes with a case (one credit or two,
  a verb that agrees) gets one key per case, never joined fragments.
- **Stored values stay English; the screen shows a label.** A value
  the API stores and filters on (a transfer's service "Money
  Transfer", its status "Sent") is never translated in the data: the
  form and filters still send the English value, and the screen shows
  it through `serviceLabel()` / `statusLabel()`
  (`lib/transferKinds.ts`), as `<option value="Sent">Enviado</option>`.
  An unknown stored value is shown as stored. A new stored value needs
  its label key there. The same holds for a batch status
  (`batchStatusLabel()`, `api/batches.ts`), a returned check's status
  and payment method (`returnCheckStatusLabel()`,
  `paymentMethodLabel()`, `api/returnChecks.ts`), a shift status
  (`timeClockStatusLabel()`, `api/timeclock.ts`) and a built-in role
  (`roleLabel()`, `api/roles.ts`); a status pill takes its tone from
  the stored value and its words from the label. Permission areas and
  actions go through `resourceLabel()`, `actionLabel()` and
  `actionShort()` (`components/PermissionMatrixTable.tsx`); the
  one-letter chips have their own keys because first letters collide
  in Spanish (Editar / Eliminar). A label helper is called during
  render, never at module level, so it follows a language switch.
- **Form schemas hold keys.** zod keeps the message it was built with,
  so a schema's message is a translator key
  (`z.string().min(1, "transfer.nameRequired")`) and the field shows
  `tIfKey(errors.x?.message)`, which translates a key and passes any
  other text through.
- **Table columns are built during render** (`transferColumns(t)` in
  the component body, not a module-level constant), so their headings
  follow a language switch. The coverage guard also checks a column's
  `header: "…"` and template attributes such as
  ``title={`Transfer #${id}`}``.

**Glossary** (use these words everywhere, so the same English word is
always the same Spanish word):

| English | Spanish |
|---|---|
| Admin (store role) | Administrador — never "Superadministrador" |
| Employee | Empleado |
| Owner | Dueño |
| Daily book | Libro diario |
| Money transfer / Transfers | Envío de dinero / Envíos |
| Money order | Giro postal |
| Over / short | Sobrante / Faltante |
| Cash drop | Depósito de efectivo |
| Lock day | Cerrar el día |
| Federal tax | Impuesto federal |
| Fee | Comisión |
| Store | Tienda |
| Settings | Configuración |
| Sign in / Sign out | Iniciar sesión / Cerrar sesión |
| Save changes / Cancel | Guardar cambios / Cancelar |
| Unsaved changes | Cambios sin guardar |
| Lock / Unlock (button) | Cerrar / Reabrir |
| In / Out (daily book columns) | Entradas / Salidas |
| Cash In / Cash Out (boxes) | Entrada de efectivo / Salida de efectivo |
| Forward balance | Saldo inicial |
| Safe balance | Saldo de la caja fuerte |
| Cash deposit (to the bank) | Depósito bancario en efectivo |
| Check deposits / On hold | Depósitos de cheques / Retenidos |
| Owed to us / We owe | Nos deben / Debemos |
| Expected back / We pay this back | Se espera de vuelta / Lo devolvemos |
| Payroll / Purchases / Expenses | Nómina / Compras / Gastos |
| Sales / Sales tax / Taxable | Ventas / Impuesto de venta / Gravable |
| Payouts | Pagos a beneficiarios |
| Payout (one transfer) | Pago a beneficiario |
| Sender / Recipient | Remitente / Beneficiario |
| Confirmation # | # de confirmación |
| Processed by | Atendido por |
| Batch (ACH) | Lote |
| Receipt (transfer) | Recibo |
| Receipt (register / POS) | Ticket |
| Dashboard | Panel |
| Returned check | Cheque devuelto |
| Batch (returned checks the bank sent back together) | Lote |
| Cleared / Held (ACH batch) | Acreditado / Retenido |
| Time clock | Reloj checador |
| Login (a person's sign-in) | Acceso |
| Role / Custom access | Rol / Acceso personalizado |
| Accountant | Contador |
| Shift / Clock in / Clock out | Turno / Marcar entrada / Marcar salida |
| Schedule / Paystub | Horario / Talón de pago |
| Passkey | Llave de acceso |
| Referrals / Referral code | Referidos / Código de referido |
| Audit log | Registro de auditoría |
| Bank transaction | Movimiento bancario |
| Matched (bank row to daily book) / Dismiss | Conciliado / Descartar |
| To reconcile / Reconciled (Bank page tabs) | Por conciliar / Conciliados |
| Bank rule / Template | Regla bancaria / Plantilla |
| Monthly P&L / P&L categories | P&L mensual / Categorías del P&L |
| Report / Report center | Reporte / Reportes |
| Commit (an import) | Confirmar |
| Owner / Linked stores | Dueño / Tiendas vinculadas |
| Connect code (owner invite) / Revoke | Código de conexión / Anular |
| Add-on / Free trial | Complemento / Prueba gratis |
| Ticket (support) / Reopen | Ticket / Reabrir |
| Pair / Unpair (TV) | Vincular / Desvincular |
| Register (POS) / Tenders / Void | Caja / Formas de pago / Anular |
| Price book / Vendor / Scan code | Lista de precios / Proveedor / Código de barras |
| Pack (lottery) / Settle | Paquete / Liquidar |
| Superadmin | Superusuario |
| Claim / Release (ticket) | Tomar / Soltar |
| Two-factor (2FA) / Recovery code | Verificación en dos pasos / Código de recuperación |
| Maintenance mode | Modo de mantenimiento |

Spanish uses the formal "usted" ("Inicie sesión", "Revise su correo").
Sentence case applies in both languages (§7b).

Covered so far: sign-in (sign-in, store picker, 2FA code step,
per-store sign-in, forgot / reset password), the app shell (sidebar,
top bar, user menu, theme button), and the kit's loading text, pager,
confirm buttons and unsaved-changes bar and prompt; the MSB daily
book (month calendar, day editor, every box and popup, money owed,
checks on hold, and its server messages), with the kit month calendar
and day / week / month stepper; transfers (the list, new and edit
forms, detail page and delete popup, receipt, sender search and
recent recipients, and their server messages), with the kit's table
error, retry button, toasts, info tip and row actions; the store and
employee dashboards, customers and merge, ACH batches, returned checks
and their payments, and the shell pieces every page can show (store
gate, impersonation bar, command palette, help panel, announcement
banner, install button, 404, and the rest of the kit); the team pages
(employees and their form, logins, roles and access, role edit, the
permission grids, payroll, schedule, punch credentials, the time
clock and the paystub); the Subscribe plan picker and the billing
server messages it can show; settings (profile, passkeys, store info
and hours, password, owner access, money services, billing and
referrals tabs), the account pages (notifications, devices, my
activity), the audit log and its shared table and filters, data
export and the switch store popup; the bank pages (accounts,
transactions, matching to the daily book, rules, the rule form and
its sentence); the monthly P&L, its edit form and P&L categories, the
report center, every report page and the Intermex report import; the
owner pages (dashboard, locations, a store's page and its permissions,
P&L rollup, cross-store reports, billing, connect a store, add user to
stores, bulk permissions, cross-store defaults, team users, activity,
owner settings) and the shared bulk results table; signup (store and
owner), the payment-received page, billing and subscription with its
cancel popup, support tickets and their conversation, and the TV
display console and country editor; the store daily book (month
calendar and day sheet, with the register closes and their popup),
register transactions, one ticket, and item movement. The day sheet's
layout comes from the server in English: a column, section or field
we ship words for (`sb.col.<column>`, `sb.<key>`) shows through
`storeBookLabel()` (`api/storebook.ts`), and one the server adds or
renames shows as sent. A ticket kind shows through `ticketKindLabel()`
(`api/posimport.ts`); one it does not know shows as sent. The rest of
the back office too: purchase invoices and their form, register
import, the price book (items, vendors, departments and their popups)
and lottery (day close, packs, games). The starter departments are
created in the reader's language, since once saved they are the
store's own names. The first platform pages: permissions, platform
reports, the platform audit log, discounts, maintenance, rule
templates, controls, the email log, setup progress, health, stores and
tickets, and the 2FA screens (code step, recovery code, enrolment). A
store plan or billing cycle shows through `planLabel()` /
`billingCycleLabel()` (`api/billing.ts`) and a ticket's status or
category through `ticketStatusLabel()` / `ticketCategoryLabel()`
(`api/support.ts`); a value they do not know shows as sent. Server
figures and setting names on the health page (`DATABASE_URL`, Stripe's
mode, a price key) stay as sent. Then billing, feature flags, the
platform dashboard, announcements, the store form, the platform report
list and the BI report page. A BI report's title is its report
center name (`reportName.<key>`); its column and total names are the
server's field names and stay as sent, like the dashboard's company
names. A banner level, an activity kind or detail the SPA does not
list shows as sent. The new store's default admin name is written in
the reader's language, since once saved it is the person's own name.
Then platform users and the store page. A trial status
(`exempt`, `active`, `expiring_soon`, `grace`, `expired`) and a recent
transfer's status show in the reader's language; one the SPA does not
list shows as sent. A module or flag name on the store page is the
server's label and stays as sent.
Emails follow the same rule: a person who picked Español gets their
emails in Spanish, everyone else (never chose, English) gets English
exactly as before. The words live in
`api/Modules/Notifications/Services/email_text.py` (`EN` / `ES`); a
template reads them through `t()` / `th()` and types no English, and
`tests/Modules/Notifications/test_email_text.py` fails otherwise.
Translated: the shared footer, password reset, the new sign-in alert,
the trial reminder, the daily summary, the locked-day digest, ticket
updates (to the store and to the platform), announcements and the
missed-shift digest, with their pushes. An announcement's message is
the superadmin's own words and goes out as typed; only its frame is
translated. A ticket reply is the person's own words too. `test.html`
is not sent by any code and stays as it is. The TV board's own words (its title,
the sample subtitle) are board content and stay as the store types
them; the country picker names each country in the reader's language
(`Intl.DisplayNames`) but saves the English name, as before. Add-on
names, taglines and prices come from the server and show as sent. An audit row's
action and target show through `auditActionLabel()` /
`auditTargetLabel()` (`components/auditFilters.ts`); a slug they
don't know, and the server-written summary, show as sent. Bank
category names come from the server (the store can rename its P&L
lines), so they show as stored. A P&L line shows through
`monthlyLineName()` (`api/monthly.ts`): the store's own name as typed,
the name we ship in the person's language. The report registry is
server text too: a report we ship words for (`reportName.<key>`,
`reportDesc.<key>`, `reportCat.<key>`) shows translated, one added on
the server first shows as sent, and so do the values inside report
rows (period P&L lines, customer buckets, statuses). The help articles
(`lib/help/registry.ts`) are still English.

## 11. The bell — one place for "something to do"

The top-bar bell (`components/NotificationBell.tsx`) is the only place
the app tells a signed-in person that work is waiting: a day not
locked, cash due back, bank rows to check, an old returned check. It
is behind the per-store `notification_bell` flag (Platform → Feature
flags), off until switched on. Owner, 2026-11-04.

- **Fixed size, fixed spot.** The button is 2.25rem square between the
  install button and the theme toggle. Its count is a `CountBadge`
  drawn on top of it, capped at "9+", hidden at 0. The bar never moves
  whether the count is 0 or 12.
- **The label carries the count:** "Notifications, 3 need attention" /
  "Notifications, none". The badge is `aria-hidden`.
- **The panel** is a Radix Popover (§5): Escape and outside click
  close it, focus returns to the bell, it scrolls inside (max 70% of
  the screen) and is the full width of a phone less 0.5rem a side.
  Each row is an `AppLink` to the page that fixes it (icon, one-line
  title, one detail line) plus a Dismiss button labelled "Dismiss for
  today: <title>". Overdue rows use the warning tone, today's the info
  tone. Empty: "You're all caught up." Footer: "Dismissed items come
  back tomorrow if they are still open."
- **Dismiss lasts one store day**, per person. The row leaves at once,
  a toast says "Dismissed for today." with Undo. During a superadmin
  "Sign in as" the bell shows but Dismiss does not (`can_dismiss`).
- **No access, no control:** a row whose page `canAccess` refuses is not
  shown, and the server only sends items the person's permissions,
  modules and features allow.
- **Adding an item** is a server source (rules in
  `api/Modules/Notifications/CLAUDE.md`) plus one row in `BELL_ITEMS`
  (`lib/bellItems.ts`): words, icon, link — sentence case, every word
  through `t()` with `bell.*` keys in English AND Spanish (§10; the
  bell is a covered screen), counts as one/many key pairs, money
  through `fmtMoney2`, days through `dayWords` (Today / Yesterday
  against the STORE's day). The row is
  typed `Record<BellKind, …>`, so a server kind without its row fails
  `npm run build`. Never a new top-bar banner or badge for the same
  job.
- Tests: `NotificationBell.test.tsx` (size at 0 / 3 / 12, labels,
  links, access, dismiss, Undo, refused dismiss, Sign in as) and
  `lib/bellItems.test.ts` (every row's words and link).

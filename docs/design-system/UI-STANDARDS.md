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
| Phone | `<PhoneField>` | — |
| One of the store's own lists from Settings (money transfer companies, transfer countries) | `<StoreListField>` over `useTransferChoices()` | hard-coded options in the SPA |

Radio-for-a-boolean is banned: a two-option radio group whose value is
a single `true/false` is a `<Checkbox>` (form) or `<Switch>` (setting).

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
| Buttons at the bottom of a popup | `<Modal actions={…}>`, or `<ModalActions>` as the last child when the body is a `<form>` (the submit button must sit inside it). Cancel first, the primary action last, right-aligned, wrapping on a phone. Never a page-local `.modalActions` class or an inline flex row |
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
  a "you have unsaved edits" line, or a second save bar.
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
- Role pills: `admin → accent`, `employee → neutral`, `owner → info`;
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
middle of a `minmax(0, 1fr) auto minmax(0, 1fr)` grid (the MSB daily
book toolbar from 78rem up); in a flush-right header the button after
it keeps one width for every label (the store daily book's lock
button).

## 4. Formatting

| Value | Formatter (`lib/formatters.ts`, `lib/datetime.ts`) | Never |
|---|---|---|
| Money | `fmtMoney2` (or `fmtMoney` for whole-dollar KPIs) | `` `$${x.toFixed(2)}` `` (drops thousands separators), private clones, inline `toLocaleString` |
| Timestamp | `formatTimestamp` (audit trails, logs; names the zone), `formatDateTime` (feeds, "locked at"), `formatTime` (time of day) | `toLocaleString()` / `toLocaleTimeString()` inline |
| Date | `formatDate`; `formatShortDate` in charts, `formatDateCompact` in dense tables, `formatDayLabel` for a day heading | `.slice(0, 10)` (wrong calendar date for US stores on UTC timestamps), `toLocaleDateString()` |
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
| Date picker | `react-day-picker` | `<DateInput>` |
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
| `BulkResultsCard` + `useStoreSelection` (owner bulk actions) | a per-store Store / Status / Notes results table with its own status → pill map, or a hand-rolled "Select all / N of M selected" store picker |
| `describeAppliedRule` (`lib/bankRules`) | your own "N tagged, N booked, N skipped (day locked)" toast text |
| `MoneyInput` | `<input type="number">` + your own cents parsing |
| `DataTable` (+ `useUrlFilterState({ pageSizeKey, defaultSort })`) | any list page's `<table>`, header row, loading / empty / error states, clickable `<tr onClick>`, sort buttons, or `<Pager>` wiring — see "Lists" in §7 |
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
| `useApiErrorToast` | `toast({ message: err instanceof ApiError ? … , tone: "error" })` |
| `*_STATUS_TONES` in `api/` (`BATCH_`, `TRANSFER_`, `RETURN_CHECK_`, `TICKET_`) | a per-route status → tone map |
| `fmtMoney2` / `formatDate` / `formatTimestamp` | `toFixed(2)`, `.slice(0, 10)`, `toLocaleDateString()` |
| `Modal`, `Tooltip`, `Switch`, `Checkbox`, `Pill` | hand-rolled equivalents |
| `KpiCard` / `KpiGrid` (`colorValue` to paint a signal figure in its tone) | a page-local stat tile, `StatRow`, or `.kpi*` / `.summaryTile` CSS |
| `CopyField` / `CopyButton` | a read-only `<input>` + Copy button with its own `navigator.clipboard.writeText` (it owns the execCommand fallback, the "Copied" flash and the failure toast) |
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
  matrix component, not a per-route copy.
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
- **In-page actions that are not links** declare what they need:
  `<Button perm="lottery.update">` and `RowActions` items with
  `perm: "users.update"` drop themselves. The value mirrors the
  `require_permission(...)` on the API route the click calls.
- **Roles are not permissions.** `identity.role === "admin"` as a
  show/hide condition is a change request: a custom access role
  (R-3) can grant or withhold any right, and a role check ignores
  it. Ask `hasPermission(resource, action)` or `canAccess(path)`.
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

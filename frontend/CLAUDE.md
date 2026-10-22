# SPA — design system and front-end rules

> Loaded automatically when Claude reads a file under `frontend/`. The
> root `CLAUDE.md` keeps the one-line invariants; this file is the
> detail. UI rules in full: `docs/design-system/UI-STANDARDS.md`.

## Before you push
```bash
npm ci                                   # node_modules is absent in a fresh session
npm run lint -- --max-warnings 0
npm run build                            # tsc -b + vite build — the type check CI runs
npx vitest run
rm -rf dist                              # never commit the build
```
`npx tsc --noEmit` against the root tsconfig checks almost nothing (it
is a solution file of project references) and passes on work CI
rejects; `tsc -b` inside `npm run build` also compiles the `*.test.tsx`
files, whose hand-built fixtures break when an exported type changes.

## Files that belong to a money module
Read that module's `INVARIANTS.md` before editing these:
- DailyBook: `src/routes/EditDailyBook.tsx`, `src/api/dailybook.ts`
- Transfers: `src/routes/NewTransfer.tsx`, `src/routes/EditTransfer.tsx`
- Monthly: `src/routes/EditMonthly.tsx`, `src/api/monthly.ts`
- BankSync: `src/api/bankSync.ts`, `src/routes/BankTransactions.tsx`,
  `src/routes/BankRules.tsx`, `src/routes/BankMatching.tsx`,
  `src/components/BankRuleForm.tsx`

## Design system — READ BEFORE TOUCHING ANY UI
**Source of truth: [`docs/design-system/`](../docs/design-system/).**
Any visual/UX change — new page, new component, restyle — starts there.
The bundle was exported from `claude.ai/design` and captures the
**dark-first, Robinhood-inspired** direction (near-black surfaces,
single neon-green `#3fff00` accent, Space Grotesk + Inter + JetBrains
Mono, inline stroke SVG nav icons). `docs/design-system/project/` is that
export: its kits are reference, its engineering notes are not.

Styling lives in:
- `static/design-tokens.css` — dark+neon tokens (`--db-*`) + legacy
  aliases, linked by `index.html` and the public TV board. New tokens go
  here, with a comment.
- `src/components/ui/ui.css` + co-located `*.module.css` — the kit's
  styles and per-route layouts.

Non-negotiables:
- **Reuse before you build — MANDATORY.** Check for an existing shared
  component BEFORE writing a new one ([UI-STANDARDS.md
  §6](../docs/design-system/UI-STANDARDS.md)). Read
  `src/components/ui/index.tsx` (the kit's export list is the
  inventory), grep for the CONCEPT rather than the name you'd have
  picked, and look at the nearest page that already does the same job.
  **Two copies is the extraction threshold**: if you are about to write
  something a second time, extract it and move the existing caller onto
  it in the SAME PR — extracting for the new page alone doubles the
  maintenance instead of halving it. The same rule holds on the backend
  (`PLAN_CATALOG` exists because plan prices had been duplicated into
  three modules and two had drifted).
- **One control per data type** (UI-STANDARDS): booleans are `<Switch>`
  (settings) or `<Checkbox>` (form fields / selection) — never Yes/No
  dropdowns or radio pairs; save-success is a toast; fetch errors are
  `<ErrorState>` with retry; money renders via `fmtMoney2`, dates via
  `formatDate` / `formatTimestamp`; pill tones carry one meaning each
  (active=accent, inactive=neutral, pending=warning, failed=negative).
  A new pattern goes into UI-STANDARDS.md in the same PR.
- **Unsaved changes — one guard on every form** (UI-STANDARDS §2). A
  form that stores typed data through a Save button uses
  `useUnsavedGuard` (+ `useDirtyBaseline` for useState forms) and
  `<FormActions guard={guard}>`: the "Unsaved changes" pill and a bar
  pinned to the window bottom while dirty, the "Leave without saving?"
  prompt on sidebar / breadcrumb / back / Cancel (one router blocker,
  `src/components/UnsavedChangesHost.tsx` — it needs the data router in
  `main.tsx`; keep `createBrowserRouter`), and the browser's prompt on
  refresh / close. Navigate after a save with `guard.proceed(...)`.
  Never write your own `beforeunload`, pill or leave dialog.
- **Write app-wide consistency changes down.** A PR that makes something
  consistent across the software adds the rule to
  `docs/design-system/UI-STANDARDS.md` (and a bullet in the root
  `CLAUDE.md` when every change must respect it) in the same PR, naming
  the shared component and what it replaces (UI-STANDARDS §9).
- **No access, no control** (UI-STANDARDS §8). A person who cannot open
  a page must not see the tab, link, button or row action that leads
  there. Route access lives in ONE table, `src/lib/access.ts`; `<Gate>`
  guards every authed route from it and `ButtonLink` / `TabsLink` /
  `AppLink` hide themselves from it. In-page actions declare
  `perm="resource.action"` (`Button`, `RowActions`). Never gate UI on
  `identity.role` — a custom access role can grant or withhold any
  right. `access.test.ts` fails when a route in `App.tsx` has no entry.
- **One name per page, sentence case, trail from the sidebar**
  (UI-STANDARDS §7b). Every label is sentence case ("Edit employee").
  A sidebar page is titled exactly its `NAV` label, a report page its
  report-center card. Every shell page renders `<PageCrumbs />` (built
  from `NAV`, never a hand-typed `<Breadcrumbs>`). Popup button rows are
  `<ModalActions>`; destructive confirms ask a question and use
  `confirmTone="danger"`; counts go through `fmtCount` / `fmtNumber`; a
  role shows as `<RolePill>` / `roleLabel()` — the store admin role is
  "Admin", never "Super Admin" — and every page that edits roles'
  permission grids renders `<RolePermissionsEditor>`.
  `src/lib/consistencyGuards.test.ts` enforces all of it.
- **Dark by default; light is opt-in.** `data-theme` flips between
  `"dark"` (default) and `"light"` (per-user, `User.theme_preference`).
  The light palette darkens the neon accent so links and active nav stay
  readable on white. New surfaces must work in BOTH themes — use
  semantic tokens (`--db-surface`, `--db-text`, `--db-border`) so values
  flip with the theme. The legacy aliases (`--navy`, `--white`,
  `--gold`, …) still resolve but never use them for a surface or text
  that should adapt; no hardcoded hex for backgrounds / text. The toggle
  is `ThemeToggle.tsx`; the per-device cache + before-paint restore live
  in `src/lib/theme.ts` + `index.html`.
- **One saturated color.** Neon green `#3fff00` — CTAs, positive values,
  active nav indicators, primary chart strokes. Second accents are jewel
  tones (`--db-co-intermex/maxi/barri`) or state
  (`--db-info/warning/negative`). **Never** introduce another brand
  color.
- **Token hierarchy.** Prefer `--db-*` tokens. Something missing from
  the palette goes into `static/design-tokens.css` with a comment, never
  inline hex. Legacy `--sky/--gold/--navy/--blue` alias to neon /
  near-black — prefer `--db-*` in new code.
- **Three fonts only.** Space Grotesk (display), Inter (body), JetBrains
  Mono (money / dates / IDs).
- **Component reuse.** Check
  `docs/design-system/project/ui_kits/{marketing,admin_app,auth}/` for
  the closest pattern; the kit-to-code mapping is in
  `docs/design-system/README.md`. Code-level primitives in
  `src/components/ui/index.tsx`: `PageShell`, `PageHeader`, `Section`,
  `Card`, `Field`, `Input`, `Select`, `Textarea`, `Button`, `ButtonLink`,
  `Alert`, `Pill`, `Pager`, `ModalActions`, `Table`, `DataTable`,
  `EmptyState`, `ErrorState`, `KpiCard`, `KpiGrid`, `FormActions`,
  `RowActions`. Reach for these before writing inline styles.
- **Per-row actions** use `<RowActions>`: inline buttons on desktop, a
  bottom-sheet menu on narrow viewports (`@media (max-width: 36rem)`).
  The sheet renders through `createPortal` so `position: fixed` pins to
  the viewport (the `.ds-page` entry animation otherwise traps it in the
  page flow). Use it wherever a row has 2+ actions;
  `src/routes/AdminTimeClock.tsx` is the canonical example.
- **Inline styles vs CSS Modules.** Kit primitives first; anything left
  (page-specific layout) goes in a co-located `<Route>.module.css`, not
  `style={{ ... }}` constants. Canonical example:
  `src/routes/AdminUserForm.tsx` + `AdminUserForm.module.css`. Forms use
  `<Field error=... hint=...>` for field-level validation and help;
  server-level errors render through `<Alert tone="error">`.
- **Forms.** `react-hook-form` + `zod` is the standard stack. One
  `useForm()` per page, schema co-located with the route. Plain inputs
  use `register("field")`; custom components wrap in `<Controller>`;
  `useWatch({ control, name })` for fields the rest of the form
  shouldn't re-render against. Canonical example:
  `src/routes/NewTransfer.tsx`.
- **The UI never leaves a user stuck.** Nothing overflows its box at any
  window size; popups scroll; pickers are never cut off — a failure
  there is a bug in the shared component. On desktop, navigation
  controls must not move when buttons beside them appear or change. A
  field that does not apply disappears rather than showing $0.
- **Emoji is retired from nav.** Use inline stroke SVGs matching the set
  (`stroke-width:2; stroke-linecap:round; fill:none; currentColor`).
  Emoji survives only in status / eyebrow prefixes (`⏳ ✅ 🔴 📣`) and
  the landing hero's `$` mark.
- **Motion is part of the design system.** Every interactive surface
  transitions between states: cards lift on hover, buttons scale-press,
  inputs glow on focus, dropdowns + modals fade-scale on open, tab
  content slides in, flash banners slide down, page navigations fade up.
  Durations ≤200 ms.
  - New dropdown / modal / tab / popover: reuse `Modal` /
    `ConfirmDialog` (keyframes in `Modal.module.css`), `TabsBar` +
    `TabsLink` / `TabsButton`, `DateInput`'s popover, `RowActions`'
    sheet, `Toast`. `UserMenu.tsx` is the dropdown example.
  - Honor `prefers-reduced-motion: reduce` (the global rule in `ui.css`);
    no inline `style={{ transition: … }}` that bypasses it.
  - Don't toggle `display: none` ↔ `block` without a bridging class,
    don't add animations >250 ms on workflow paths, and don't animate
    layout properties (height / width / margin) above the reading
    position.

## Sidebar (root invariant 2)
The nav is ONE table, `NAV` in `src/components/navConfig.tsx` (store:
Dashboard · Daily · Money services · Team · Reports · Finance · Displays
· Owner · Account; superadmin adds **Platform**). A new page belongs to
exactly one group: add the link there and the route's access row in
`src/lib/access.ts`. `filterNavForRole` hides items the person cannot
open and groups left empty.

## Lists (root invariant 14)
Every paginated table searches as you type — **never** a "type then
click Search" form. Use `useUrlFilterState`
(`src/lib/useUrlFilterState.ts`): filters live in the URL (shareable,
back / forward restore them), the free-text box debounces at **300 ms**
with a **2-char minimum**, any filter change resets to page 1, selects
and date pickers apply immediately. The list endpoint takes the filters
as query params and returns the `api.Core.Pagination` envelope. The
table is the kit `<DataTable>` (row count, rows per page, server sort,
keyboard rows, phone cards — UI-STANDARDS §7). Reference:
`src/routes/Transfers.tsx`.

## OpenAPI → TypeScript types
The SPA reads request / response shapes from `src/api/openapi.d.ts`,
generated from the FastAPI app's OpenAPI spec. **Never edit it by
hand.** Regenerate after any Pydantic schema or route change:
```bash
npm run generate-types   # scripts.dump_openapi → openapi.json → openapi.d.ts
```
Both files are checked in. Consume them with
```typescript
import type { components } from "./openapi";
type AnnouncementRow = components["schemas"]["AnnouncementRow"];
```
Never hand-write an interface the server already describes:
`src/api/generatedTypes.test.ts` fails when an `export interface` in
`src/api/` shares its name with a generated schema. The few kept by
hand (fields Pydantic defaults make optional, a narrower literal union)
are listed there with their reason. Shapes the server has no schema
for (`dict` responses) still migrate on touch, by giving the route a
response model. `announcements.ts` is the canonical example.

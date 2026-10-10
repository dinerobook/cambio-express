# DineroBook — Engineering Context

> This file is read automatically by Claude Code at the start of every
> session. Keep it short, accurate, and update it whenever an invariant
> changes. The goal is **no quiet regressions** on the rules below.
>
> **New account / picking up in-flight work?** Read
> [`HANDOFF.md`](HANDOFF.md) too — it holds the current roadmap, known
> unfixed bugs, and pre-launch ops gates that don't live anywhere else.

## What this is
A multi-tenant bookkeeping SaaS for money-service businesses (MSBs —
small shops that send remittances via Intermex / Maxi / Barri and keep
daily cash-ledger + monthly P&L). Each **Store** has admins + employees;
multi-store **Owners** connect via invite codes; the platform runs under
one **Superadmin**.

## Stack
- FastAPI / Starlette on ASGI (uvicorn). Flask was removed in
  PR #550 — `app.py`, `blueprints/`, and `api/Flask/` no longer
  exist; `asgi.py` is the single entry point. Every route lives
  under `api/Modules/<domain>/Controllers/` and the SPA shell
  serves from `api/spa.py`.
- SQLAlchemy 3.1, SQLite in dev, Postgres in prod.
- Alembic is the sole source of schema truth (see "Migrations").
- React 19 SPA (Vite) under `frontend/` is the whole UI. Styling:
  - `static/design-tokens.css` — dark+neon tokens (`--db-*`) + legacy
    aliases, linked by `frontend/index.html` and the public TV board.
  - `frontend/src/components/ui/ui.css` + co-located `*.module.css`
    — the kit's styles and per-route layouts.
  - Jinja2 survives only for `templates/offline.html`,
    `templates/tv_display_public.html` and `templates/emails/`.
- Stripe for billing (Checkout Sessions + Billing Portal + webhooks).
- Casbin (`pycasbin` + `casbin-sqlalchemy-adapter`) for RBAC.
  Replaced custom `RolePermission` / `StoreRoleOverride` tables in
  PR #761; legacy tables dropped in PR #763. Live enforcement
  (no JWT staleness) — see `api/Core/Permissions/`. One enforcer
  per web worker: permission writers go through
  one transactional writer (`_replace_subject_rows`: one
  subject's rows swapped in one DB transaction, optionally
  joining the request session) and never call `save_policy()`
  (it rewrites the whole table from one worker's memory) or the
  enforcer's row-by-row API; readers reload every
  `PERMISSIONS_RELOAD_SECONDS` (2 s). Faults fail closed once a
  policy has loaded. See `api/Modules/Auth/INVARIANTS.md`.
- pytest for the Python suite; Vitest + Testing Library for the SPA.

## Design system — READ BEFORE TOUCHING ANY UI
**Source of truth: [`docs/design-system/`](docs/design-system/).** Any
visual/UX change — new page, new component, restyle — starts there.
The bundle was exported from `claude.ai/design` and captures the
**dark-first, Robinhood-inspired** direction (near-black surfaces,
single neon-green `#3fff00` accent, Space Grotesk + Inter +
JetBrains Mono, inline stroke SVG nav icons).

Non-negotiables:
- **Reuse before you build — MANDATORY. Check for an existing
  shared component BEFORE writing a new one.** See
  [UI-STANDARDS.md §6](docs/design-system/UI-STANDARDS.md). Read
  `frontend/src/components/ui/index.tsx` (the kit's export list is
  the inventory), grep for the CONCEPT rather than the name you'd
  have picked, and look at the nearest page that already does the
  same job. **Two copies is the extraction threshold**: if you are
  about to write something a second time, extract it and move the
  existing caller onto it in the SAME PR — extracting for the new
  page alone doubles the maintenance instead of halving it. The
  same rule holds on the backend (`PLAN_CATALOG` exists because
  plan prices had been duplicated into three modules and two had
  drifted). §6 carries the inventory table and a worked example of
  what skipping this costs.
- **One control per data type — see
  [`docs/design-system/UI-STANDARDS.md`](docs/design-system/UI-STANDARDS.md).**
  Binding for every UI change: booleans are `<Switch>` (settings) or
  `<Checkbox>` (form fields / selection) — never Yes/No dropdowns or
  radio pairs; save-success is a toast; fetch errors are
  `<ErrorState>` with retry; money renders via `fmtMoney2`, dates via
  `formatDate`/`formatTimestamp`; pill tones carry one meaning each
  (active=accent, inactive=neutral, pending=warning,
  failed=negative). When a new pattern is needed, add it to that file
  in the same PR.
- **No access, no control — see
  [UI-STANDARDS.md §8](docs/design-system/UI-STANDARDS.md).** A
  person who cannot open a page must not see the tab, link,
  button or row action that leads there. Route access lives in
  ONE table, `frontend/src/lib/access.ts`; `<Gate>` guards every
  authed route from it and `ButtonLink` / `TabsLink` / `AppLink`
  hide themselves from it. In-page actions declare
  `perm="resource.action"` (`Button`, `RowActions`). Never gate
  UI on `identity.role` — a custom access role can grant or
  withhold any right. `access.test.ts` fails when a route in
  `App.tsx` has no table entry.
- **Dark by default; light is opt-in.** ``data-theme`` flips
  between ``"dark"`` (default) and ``"light"`` (per-user
  preference, stored on ``User.theme_preference``). The light
  palette deliberately darkens the neon accent so links + active
  nav stay readable on white. New surfaces must work in BOTH
  themes — use semantic tokens (``--db-surface``, ``--db-text``,
  ``--db-border``) instead of fixed hex so values flip with the
  theme attribute. The toggle lives in the topbar
  (``ThemeToggle.tsx``); the per-device cache + before-paint
  restore live in ``frontend/src/lib/theme.ts`` +
  ``frontend/index.html``.
- **One saturated color.** Neon green `#3fff00` — reserved for CTAs,
  positive values, active nav indicators, primary chart strokes.
  Second accents = jewel tones (`--db-co-intermex/maxi/barri`) or
  state (`--db-info/warning/negative`). **Never** introduce another
  brand color.
- **Token hierarchy.** Prefer `--db-*` tokens from
  `static/design-tokens.css`. If you need something not in the palette,
  add it there with a comment, don't inline hex. Legacy `--sky/--gold/
  --navy/--blue` are aliased to neon/near-black — they still work but
  prefer `--db-*` for new code.
- **Three fonts only.** Space Grotesk (display), Inter (body),
  JetBrains Mono (money/dates/IDs). No other faces.
- **Component reuse.** Check
  `docs/design-system/project/ui_kits/{marketing,admin_app,auth}/`
  for the closest existing pattern before hand-rolling. The mapping
  between kit components and live code lives in
  `docs/design-system/README.md`. Code-level primitives live in
  `frontend/src/components/ui/index.tsx` — `PageShell`,
  `PageHeader`, `Section`, `Card`, `Field`, `Input`, `Select`,
  `Textarea`, `Button`, `ButtonLink`, `Alert`, `Pill`, `Pager`,
  `Table`, `EmptyState`, `ErrorState`, `KpiCard`, `KpiGrid`,
  `FormActions`, `RowActions`. Reach for these before writing
  inline styles.
- **Per-row actions** use `<RowActions>` — the kit primitive
  that renders inline buttons on desktop and collapses into a
  bottom-sheet menu on narrow viewports (`@media (max-width:
  36rem)`). The sheet renders through `createPortal` so
  `position: fixed` pins to the viewport (the `.ds-page`
  entry animation otherwise establishes a containing block
  and traps the sheet inside the page flow). Use this anywhere
  a table or list row has 2+ actions — keeps mobile UX
  consistent across the SPA. `AdminTimeClock.tsx` is the
  canonical example.
- **Inline styles vs CSS Modules.** New routes should reach for
  kit primitives first. Anything left over (page-specific layouts,
  one-off treatments) goes into a co-located `<Route>.module.css`
  file rather than `style={{ ... }}` constants at the bottom of
  the route. The canonical example post-migration is
  `frontend/src/routes/AdminUserForm.tsx` +
  `AdminUserForm.module.css` — every input/button/alert is a kit
  primitive; only the card header row + checkbox row are in the
  module. Vite's `vite/client` types already handle `.module.css`
  imports, no config change needed. Forms use `<Field error=...
  hint=...>` for field-level validation + inline help; server-
  level errors render through `<Alert tone="error">`.
- **Forms.** `react-hook-form` + `zod` is the standard stack
  (PR #562). One `useForm()` per page, schema co-located with
  the route. Plain inputs use `register("field")`; custom
  components (autocompletes, etc.) wrap in `<Controller>`.
  `useWatch({ control, name })` for fields the rest of the form
  shouldn't re-render against. The canonical example for the
  full layout-+-form stack is
  `frontend/src/routes/NewTransfer.tsx`.
- **Emoji is retired from nav.** Replace any new emoji nav icon with
  an inline stroke SVG matching the existing set
  (`stroke-width:2; stroke-linecap:round; fill:none; currentColor`).
  Emoji survives only in status/eyebrow prefixes (`⏳ ✅ 🔴 📣`) and
  the landing hero's `$` mark.
- **Motion is part of the design system.** Every interactive surface
  should transition between states — no instant pop-ins, no abrupt
  swaps. Cards lift on hover, buttons scale-press on click, inputs
  glow on focus, dropdowns + modals fade-scale on open, tab content
  slides in on swap, flash banners slide-down on mount, page
  navigations fade-up. Durations are tight (≤200ms) so the app
  feels responsive, not laggy.

  **When you build a new dropdown / modal / tab / popover:**
  - Reuse the kit rather than inventing your own: `Modal` /
    `ConfirmDialog` (fade-scale keyframes in `Modal.module.css`),
    `TabsBar` + `TabsLink` / `TabsButton`, `DateInput`'s popover,
    `RowActions`' bottom sheet, `Toast`. `UserMenu.tsx` is the
    dropdown example.
  - Honor `prefers-reduced-motion: reduce` — the kit's `ui.css`
    carries the global rule that strips animations + transitions.
    Don't write inline `style={{ transition: … }}` that bypasses it.

  **Don't:**
  - Use `display: none` ↔ `display: block` toggles without a
    bridging class — display can't transition.
  - Add long animations (>250ms) on workflow paths.
  - Animate properties that cause layout shift (height/width,
    margin) on elements above the user's reading position.

## Production deploy target (single source of truth)
- **Web service**: `dinerobook` on Render → `https://dinerobook.com` (custom domain; the underlying Render hostname `dinerobook.onrender.com` is no longer canonical)
- **Database**: `dinerobook-db` on Render (linked via `fromDatabase:` in `render.yaml`)
- The older `cashnet` service / `cambio-db` database are decommissioned.
  Never add references to them, never point env vars at them, never run
  migrations against them. If a new service is ever needed it must be
  declared in `render.yaml` and auto-deploy from `main`.

## Running locally
```bash
pip install -r requirements.txt
uvicorn asgi:asgi_app --reload --port 5000   # dev server on :5000
pytest tests/                                # full suite
python -m scripts.purge_expired_stores       # deletes inactive stores past retention
python -m scripts.send_trial_reminders       # daily cron — trial-ending emails
python -m scripts.send_daily_summaries       # daily cron — per-store close-out summary
python -m scripts.send_missed_shift_digest   # daily cron — missed planned shifts
python -m scripts.broadcast_announcement N   # resend announcement #N
python -m scripts.backfill_federal_tax       # one-shot — recompute Transfer.federal_tax
```
Set `DEV_RELOAD=1` for hot-reload on Python edits. The Vite dev
server (port 5173) handles SPA reload on its own.

**Prefer Postgres for dev** (parity with prod — the SQLite/Postgres
split is being retired, HANDOFF.md §2):
```bash
docker compose up -d          # local Postgres 16 on 127.0.0.1:5432
export DATABASE_URL=postgresql://dinerobook:dinerobook@localhost:5432/dinerobook
uvicorn asgi:asgi_app --reload --port 5000
```
`docker compose --profile queue up -d` also starts Redis for the
job queue (then set `JOB_QUEUE_ENABLED=1` + `REDIS_URL`). The
`Dockerfile` builds the full production image (SPA bundle + ASGI
app) — Render doesn't use it; it exists so the app stays portable
to any container host.
First boot seeds a superadmin (`superadmin / super2025!`) and demo store
admin (`admin / cambio2025!`). Override via `SUPERADMIN_PASSWORD` /
`ADMIN_PASSWORD` env vars in prod.

Passkey env (optional): `WEBAUTHN_RP_ID` pins the WebAuthn Relying
Party ID in prod (set to `dinerobook.com`, the canonical custom
domain). Dev falls back to `request.host` with the port stripped,
so `localhost:5000` works out of the box. **Changing this value
invalidates every existing passkey** — they're bound to the rpId
that was active at registration time.

## Critical invariants — don't break these

### Per-module `INVARIANTS.md` — read these first

Money-flow modules carry a co-located `INVARIANTS.md` file that
captures the rules NOT obvious from the code (field categories,
locked-day semantics, math formulas, cross-module dependencies,
the 422-trap field list).

**Before editing a file in one of these modules, read the local
`INVARIANTS.md`:**

- `api/Modules/DailyBook/INVARIANTS.md` — daily ledger. Field
  categories (operator-editable / line-item-derived /
  cross-table-derived), lock rules, the 422 trap, the math
  formulas. `frontend/src/routes/EditDailyBook.tsx` +
  `frontend/src/api/dailybook.ts` count as "DailyBook files" too.
- `api/Modules/Transfers/INVARIANTS.md` — transfer ledger. The
  money math (`total_collected = send_amount + fee + federal_tax`),
  the server-computed federal-tax rule, the Customer upsert
  chain across the owner umbrella, status semantics, audit
  contract, employee attribution, cross-module dependencies
  (Batches / Monthly / DailyBook). `api/Modules/Customers/
  Services/customers.py` upsert + `frontend/src/routes/
  NewTransfer.tsx` + `EditTransfer.tsx` count as "Transfers
  files" too.
- `api/Modules/Monthly/INVARIANTS.md` — monthly P&L. Field
  categories (operator-editable / daily-derived /
  cross-table-derived), the 422 trap for every read-only field,
  the income / expense / net-profit formulas, the auto-derive
  contract ("trust the ledger, never the stored value"), the
  `bank_charges_total` conditional-lock rule that Basic-plan
  stores depend on for manual entry, and the per-store line
  RENAMING rules (a label never moves a column;
  `MONTHLY_LINE_DEFAULTS` is the one place default names live).
  `frontend/src/routes/EditMonthly.tsx` +
  `frontend/src/api/monthly.ts` count as "Monthly files" too.
- `api/Modules/Auth/INVARIANTS.md` — login, 2FA, recovery codes,
  passkeys. The `_TOTP_REQUIRED_ROLES` single role gate, the
  Casbin-backed permissions matrix (privilege escalation
  surface — `RBAC_DEFAULTS` + the `casbin_rule` table), the
  opaque-error-message rule (anti-enumeration), the pending vs
  access token purpose separation, the passkey-register
  TOTP-first rule for superadmin, the forward invariant for a
  passkey-LOGIN flow (when it lands, must follow the documented
  rules), and the `WEBAUTHN_RP_ID` invalidate-everything rule.
  Auth changes deserve an explicit review header in the PR
  description.

- `api/Modules/BankSync/INVARIANTS.md` — bank feed. The three
  category families and what tagging does, the booking contract
  (roll-up through the daily-book service, locked days refused,
  `report_date`, idempotent re-tag), the rules contract (AND
  conditions, first match wins, never override a hand tag,
  apply-to-existing), the P&L feed. `frontend/src/api/bankSync.ts`,
  `routes/BankTransactions.tsx`, `routes/BankRules.tsx` and
  `components/BankRuleForm.tsx` count as "BankSync files" too.

When more INVARIANTS docs land (Batches), add them to
this list. The point: a `frontend/src/routes/Bank.tsx` edit
needs the Bank invariants in scope; a daily-book edit needs
the daily-book ones; a transfer edit needs the transfer ones;
a monthly P&L edit needs the monthly ones.

### Code-level invariants

1. **Design system is the source of truth.** See
   [`docs/design-system/`](docs/design-system/) and the "Design
   system" section above. Dark by default, neon `#3fff00` as sole accent,
   Space Grotesk + Inter + JetBrains Mono.

   The Flask-era stylesheets (`static/app.css`, `static/content.css`)
   and every `base.html` template are gone; the SPA kit in
   `frontend/src/components/ui/` replaces their classes. Reach for a
   kit primitive (UI-STANDARDS §6) rather than rolling your own.

   **For ANY surface, text, or border that should respect the
   light/dark toggle, use the semantic tokens** (`--db-surface`,
   `--db-text`, `--db-border` and friends in `static/design-tokens.css`)
   — they flip with `data-theme`. The legacy aliases (`--navy`,
   `--white`, `--gold`, …) still resolve but never use them for a
   surface or text that should adapt; no hardcoded hex for
   backgrounds/text either.

2. **Sidebar groupings** — the nav is ONE table, `NAV` in
   `frontend/src/components/navConfig.tsx` (store: Dashboard · Daily ·
   Money services · Team · Reports · Finance · Displays · Owner ·
   Account; superadmin adds **Platform**). New pages belong to exactly
   one group; add the link there and the route's access row in
   `frontend/src/lib/access.ts`. `filterNavForRole` hides items the
   person cannot open and groups left empty.
3. **Trial state machine** — `Store.plan ∈ {trial, basic, pro, inactive}`.
   `get_trial_status(store)` returns `active | expiring_soon | grace |
   expired | exempt`. Routes allowed during `expired` are enumerated in
   `_TRIAL_EXEMPT` — extend this set when you add routes that must stay
   reachable after the trial ends (subscribe, logout, billing portal,
   cancel, admin_subscription, the new password-reset routes).
4. **Data retention** — on Stripe `customer.subscription.deleted` we set
   `Store.data_retention_until = now + 180 days`. On resubscribe
   (`checkout.session.completed`) we clear it. `purge_expired_stores()`
   cascades through every per-store table (`_STORE_OWNED_MODELS`) before
   deleting the `Store` row. Add new per-store models to that list.
5. **Customer upsert (owner umbrella scope)** —
   `find_or_upsert_customer()` is the only path that creates or updates
   `Customer` rows from the transfer form. Lookup order:
   1. explicit `customer_id` (only reused if the target customer lives
      in a sibling store — the current store's owner umbrella);
   2. `(phone_country, phone_number)` across **every store that shares
      an owner with the current store** via `sibling_store_ids()` —
      so a cashier at Store B finds the sender that Store A logged;
   3. else create a new record pinned to the current `store_id`.
   A Customer row always stays pinned to its home store; transfers at
   sibling stores just point `customer_id` at it (no duplication). Newest
   values overwrite — edits from anywhere in the umbrella propagate.
   Unrelated stores (no owner overlap) remain fully isolated.
6. **Feature flags** — `store_feature_enabled(store, key)` resolves
   per-store override → global default → **fail-open** (undeclared flag
   returns True). New optional features should gate on a flag named
   `addon_<key>` (for add-ons) or a descriptive key (`bank_sync`,
   `multi_store_owner`). Declare defaults in `_DEFAULT_FEATURE_FLAGS`.
7. **Audit log** — every superadmin mutation calls `record_audit(action,
   target_type, target_id, details)`. Don't commit a superadmin route
   that mutates state without an audit entry.
8. **Stripe checkout** — `subscribe_checkout` passes
   `allow_promotion_codes=True`. Do not remove it: discount redemption
   depends on it.
9. **Fee vs Federal tax** — `Transfer.fee` is store revenue;
   `Transfer.federal_tax` leaves with the ACH withdrawal. Always:
   - `Transfer.total_collected = send_amount + fee + federal_tax`
   - `ACHBatch.transfers_total   = Σ (send_amount + federal_tax)`
10. **Password reset** — tokens are stored as `sha256(raw)` in
    `PasswordResetToken.token_hash`, single-use, 1-hour expiry. The raw
    token never hits the DB. `/forgot-password` always responds with
    "Check your email" regardless of whether the account exists.
    **Superadmin is deliberately excluded** from the email flow — an
    attacker who compromises the superadmin mailbox would bypass 2FA.
    Superadmin recovery goes through `python -m scripts.reset_superadmin`
    on the Render shell (optionally `--reset-2fa` to also wipe TOTP if
    the recovery codes are lost). The legacy `flask reset-superadmin`
    CLI is gone — Flask was removed in PR #550.
11. **`db.session.get(Model, id)`** — never `Model.query.get(id)` (legacy
    SQLAlchemy 2.0 API, emits deprecation warnings).
12. **Referrals** — `ReferralCode` is one-per-store, minted lazily by
    `ensure_referral_code(store)` when an admin on a paid plan loads any
    page (context processor does this) and explicitly by the
    `checkout.session.completed` webhook. Credits are applied by
    `apply_pending_referral_credits(referee_store)` also inside that
    webhook — $50 to the referee, $100 to the referrer, via Stripe
    `create_balance_transaction`. Idempotent: `ReferralRedemption` is the
    lockout row and `Store.referee_credit_applied_at` gates retries. The
    topbar crown reads `my_referral_code` from the context processor —
    empty string hides it, so the button self-gates on role + plan.
13. **2FA (TOTP) is mandatory for superadmin — *unless* they sign in
    with a passkey.** Login routes are the only source of truth:
    - `/login` POST (password flow) → if creds valid AND
      `_needs_totp(user)` returns True, set
      `session["pending_auth_user_id"]` (NOT `user_id`) and redirect
      to `/login/2fa/enroll` (first time) or `/login/2fa`.
    - `/login/2fa/*` may call `_finalize_2fa_login(user)`, which
      promotes `pending_auth_user_id` → real `user_id`. **Never set
      `session["user_id"]` directly from the password-login path for
      a role that `_needs_totp` returns True for.**
    - **Passkey carve-out (FORWARD INVARIANT — not yet implemented).**
      Passkey *registration* exists today, but a passkey-*login* flow
      does NOT — see `api/Modules/Auth/INVARIANTS.md` for the
      authoritative status. When it lands, `/login/passkey/finish`
      may set `session["user_id"]` directly *after* successfully
      verifying a WebAuthn assertion, even when `_needs_totp(user)` is
      True: a passkey is phishing-resistant MFA by construction
      (device-bound, user-presence-proven, RP-ID-bound), so stacking
      TOTP on top adds friction without adding security. The rule the
      future flow must honor: full-auth promotion requires either a
      TOTP factor OR a verified passkey assertion; no other code path
      may set `user_id` directly. Until that flow ships, the ONLY
      direct-promotion path is `_finalize_2fa_login`.
    - Recovery codes: 10 per user, sha256-hashed, single-use
      (`RecoveryCode.used_at`). Shown in plaintext exactly once on the
      post-enrollment recovery-codes page.
    - TOTP secret (`User.totp_secret`) is base32 plaintext in the DB —
      the DB is the trust boundary, same as `password_hash`.
    - Passkey storage: `Passkey` table holds `(user_id, credential_id,
      public_key, sign_count, aaguid, name)`. `credential_id` is
      unique and the lookup key at login time. `sign_count` is
      authenticator-reported; we accept equal-or-greater values and
      reject resets to protect against cloned authenticators.
    - To extend 2FA to other roles, change the single `_needs_totp()`
      predicate; do NOT scatter role checks through the login routes.
14. **Table search UX — live-search is the standard.** Every paginated
    table (transfers is the reference implementation) searches as you
    type — **never** a plain "type then click Search" form. Use
    `useUrlFilterState` (`frontend/src/lib/useUrlFilterState.ts`):
    filters live in the URL (shareable, back/forward restore them),
    the free-text box debounces at **300ms** with a **2-char
    minimum**, any filter change resets to page 1, selects + date
    pickers apply immediately. The list endpoint takes the filters as
    query params and returns the `api.Core.Pagination` envelope.
    Reference: `frontend/src/routes/Transfers.tsx`.
15. **Rate limiting** — every auth route, password-reset route, and
    webhook ingest endpoint is bucketed by slowapi on the FastAPI
    side. The Flask-Limiter twin is gone — Flask has no remaining
    POST surface to limit.
    - Shared singleton `slow_limiter` in `api/Core/RateLimit.py`.
      Critical endpoints carry `@_rate_limiter.limit(...)`
      decorators on their controllers (look for `from
      api.Core.RateLimit import limiter as _rate_limiter` in
      `api/Modules/Auth/Controllers/__init__.py`).
    - Storage backend defaults to in-memory; prod sets
      `RATELIMIT_STORAGE_URI=redis://...` in `render.yaml` so the
      bucket holds across workers. `RATELIMIT_ENABLED=0` disables
      the limiter (the test conftest sets this — never set it in
      prod).
    - slowapi captures `enabled` at import time, so toggling the
      flag at runtime doesn't re-arm decorators that were created
      with `enabled=False`. Tests that exercise the 429 path spawn
      a subprocess (see `tests/test_rate_limiting.py`).
    - Don't tighten the limits casually — integration tests and
      Stripe webhook retries both burn rate budget. Loosening is
      always safer than the alternative.
16. **Background-job queue (BACKLOG D5)** — heavy / slow work in
    a request handler goes through ``api.Core.Jobs.enqueue(...)``,
    not a direct call. Examples: SMTP send (the
    ``/forgot-password`` flow already uses this — see
    ``send_password_reset_email`` in
    ``api/Modules/Auth/Controllers/__init__.py``), Stripe SDK
    round-trips that don't have to land before the response, and
    anything that fans out to N recipients.
    - Activation is opt-in via ``JOB_QUEUE_ENABLED=1`` +
      ``REDIS_URL`` env vars on both the web service and the
      worker. Either missing → sync execution (the default; same
      semantics as a direct call). This keeps the test suite + the
      default dev loop running without Redis.
    - Worker service is staged commented in ``render.yaml`` —
      see the 4-step activation runbook embedded in the YAML
      comments. Uncomment after Redis is provisioned and the env
      vars are set.
    - Args MUST be primitives (ids, dicts, strings) — not ORM
      objects. RQ pickles args for the worker, and the request
      session is closed by the time the worker runs. Worker
      functions open their own ``SessionLocal`` to reload state.
    - Worker functions are top-level (not closure-scoped) so RQ
      can pickle them by import path.
    - Tests in ``tests/Core/test_jobs.py`` exercise both modes
      (sync + queued) and the defensive partial-env fallback.
17. **CSRF protection** — Flask has no POST surface anymore so
    Flask-WTF is gone. The SPA talks to FastAPI over Bearer JWT
    in the Authorization header, which is naturally CSRF-immune
    (browsers don't attach it to cross-origin requests by
    default). Webhook endpoints verify provider signatures
    (Stripe `Stripe-Signature`, Resend HMAC) so they don't rely
    on session-cookie auth either. If you ever reintroduce a
    cookie-authenticated form-POST surface, add CSRF protection
    back at that point — don't bolt cookie auth onto a JSON
    endpoint without it.
18. **The rank rule and the live principal** — see
    `api/Modules/Auth/INVARIANTS.md`. Every route that changes
    another person's role, password, active flag, custom access
    or saved role goes through `api/Core/Permissions/ranks.py`
    (manage at or below your own rank, assign roles at or below
    it, never grant what you don't hold). A matrix body is
    validated in full before the first Casbin write.
    `get_principal` checks the user row and the session's refresh
    rows on every request, so revoking sessions, demoting,
    deactivating or resetting a password signs the person out on
    their next call. Don't add a user-editing route that skips
    the rank helpers, and don't make `get_principal` DB-free.
    Every matrix route is typed by and runs through
    `api/Core/Permissions/matrix_update.py` on the request's own
    session (body shape 422, non-editable role 403, nothing
    written before the audit row commits); sessions end only
    through `revoke_refresh_tokens`. Don't write a fourth copy of
    that loop, and never touch `RefreshToken.revoked_at` inline.

## Migrations
**Every schema change is an Alembic revision.** Generate one with:
```bash
alembic revision --autogenerate -m "add foo.bar"
```
Review + edit the generated file under `alembic/versions/`
(autogenerate gets most things right but misses data backfills
and SQLite batch-mode quirks — read every line before committing).

`init_db()` runs `alembic upgrade head` on boot — that's the sole
schema mechanism. Fresh dev DBs are built by the baseline
migration + every subsequent revision; existing DBs upgrade in
place. There is no `db.create_all()`, no `_ADDED_COLUMNS` list.

**Never drop a column from a running database without a backfill
step** — rename it in one revision, copy data over, drop the old
column in a follow-up revision once the dual-write window has
elapsed.

**A migration NEVER imports application code.** Spell the columns
out literally, even when a model already has the list. Two reasons,
and the first is the important one:

1. **A migration is immutable history.** If it derives its columns
   from a model, renaming a field later silently changes what that
   historical revision creates — a database rebuilt from scratch
   stops matching one migrated in place. Alembic is the sole source
   of schema truth, and truth that follows application code isn't
   truth.
2. Alembic imports every file in `alembic/versions/` to build the
   revision graph, and `init_db()` runs that during boot — so a
   top-level `from api.…` drags the model layer into the boot path
   from inside the migration loader.

When a literal list could drift from a model, add a test that
asserts the two agree (see
`tests/Modules/StoreBook/test_migration_matches_model.py`, which
also asserts the migration imports no application code at all).
That's how you get both safety and immutability.

## Table naming — every table carries its area prefix
**Every application table is named `<area>_<thing>`.** The prefix
says which part of the product owns the table, which module folder
it lives in, and which `INVARIANTS.md` to read before touching it.
It is an *area*, not a tenancy marker — whether a row is pinned to
one store is already on the row as `store_id`.

| Prefix | Modules |
|---|---|
| `tenancy_` | Tenancy |
| `auth_` | Auth |
| `billing_` | Billing, FeatureFlags |
| `platform_` | Superadmin, Webhooks, Announcements |
| `support_` | Support |
| `audit_` | Audit |
| `bank_` | BankSync |
| `hr_` | TimeClock |
| `msb_` | Transfers, Customers, Batches, DailyBook, Monthly, ReturnChecks, TVDisplay |
| `retail_` | DayClose, StoreBook, Lottery, PosImport, Catalog |

The map is `MODULE_PREFIX` in `api/Core/Schema.py`; the generated
developer map of every table (module, scope, foreign keys, which
INVARIANTS to read) is [`docs/SCHEMA.md`](docs/SCHEMA.md).

**When you add a table:** name it with its module's prefix, then run
`python -m scripts.dump_schema_doc` and commit the regenerated
`docs/SCHEMA.md`. **When you add a module:** add it to
`MODULE_PREFIX`. `tests/Core/test_table_prefixes.py` fails on a
wrong prefix, an unmapped module, or a stale doc. Library-owned
tables (`alembic_version`, `casbin_rule`) keep their upstream names.

Historical migrations before `c4a9e7d21f08` create the OLD names
and are immutable — the rename revision at that point moves every
table, its `ix_<table>_*` indexes, and (Postgres) its auto-named
constraints and id sequence. Never edit an old revision to use a
new name.

## Bank feed → books (categories, rules, P&L feed)

**Read `api/Modules/BankSync/INVARIANTS.md` before touching any of
this.** The short version:

- A bank transaction gets ONE category slug, and the slug decides
  where the money lands. Three families, all listed by
  `GET /api/v2/bank/categories` (the SPA never hard-codes slugs):
  - **Daily-book kinds** (`LINE_ITEM_KINDS`) — tagging BOOKS a
    `msb_daily_line_item` on the day's book through
    `recompute_line_items_total`, so the day's column moves and
    the report row is created if missing. A locked day refuses
    (service `DailyBookLockedError`, endpoint 409, rule engine
    keeps the tag and skips the line). **Which day it lands on is
    the operator's**: `report_date` on the categorize call, stored
    as `bank_transaction.report_date_override`, so the choice
    survives a re-tag — the bank's `posted_at` is only the
    fallback.
  - **Monthly P&L lines** (`BANK_PL_CATEGORIES`, slugs `pl_*`) —
    summed straight into the mapped `MonthlyFinancial` column by
    `bank_pl_sums_for_month`, locked per column per month only
    when the bank has rows for it (Basic-plan stores keep typing).
    The option's LABEL is the store's, from
    `Monthly.Services.labels` — `BANK_PL_CATEGORIES` maps slug →
    column and holds no names. A blank `other_expense_*` /
    `other_income_*` slot the store has not named stays out of the
    picker and is refused by the server; naming it on
    `/monthly/categories` is how a store gets a category we did
    not ship.
  - **Other tags** (`BANK_CATEGORIES_NON_POSTING` + one
    `bank_charge_<last4>` per connected account) — tag only; the
    `bank_charge*` family feeds `bank_charges_total`.
- **Rules** (`bank_rule`) are the operator's automation: IF
  description / direction / amount / account THEN category (+ book
  on a day `post_date_offset_days` from the bank's — a rule fires
  on rows nobody has seen, so it shifts rather than names a day).
  First match wins in `priority` order; `POST /rules/reorder`
  rewrites priorities. Rules never override a hand-set tag. Create
  with `apply_to_existing` or `POST /rules/{id}/apply` to run one
  over existing uncategorized rows — the response carries
  `{tagged, booked, locked_skipped}`. The SPA's "Make a rule" on a
  transaction row prefills the shared `BankRuleForm`.
- **Adding a bank-fed P&L line** = one `BANK_PL_CATEGORIES` row
  whose column is in `EDITABLE_MONTHLY_FIELDS`,
  `INCOME_FIELDS` / `EXPENSE_FIELDS` and `MONTHLY_LINE_DEFAULTS`.
  Nothing else to wire. `taxable_sales` / `non_taxable` are
  deliberately NOT bank-taggable — the register close already
  books the day's sales.

### Built-in rules (platform-managed bank charges)
Standard bank charges from a known institution shouldn't require the
operator to set up their own rule. Example: Nizari Progressive's
`REMOTE DEPOSIT FEE` always lands on the MSB ••0230 account. Edit
`BUILTIN_BANK_RULES` in `api/Modules/BankSync/Services/builtin_rules.py`
— each entry is `("DESCRIPTION SUBSTRING", "ACCOUNT_LAST4_OR_BLANK",
"TARGET_KIND")`, matched case-insensitively, never on amount.
Built-ins fire AFTER operator rules, only on still-uncategorised
rows, and NEVER book a daily-book line. Every new entry needs a
positive + a negative (wrong account) matcher test — see
`tests/Modules/BankSync/test_builtin_rules_service.py`.

## Module map (api/Modules)
Every domain owns four layers: `Models`, `Repositories`,
`Services`, `Controllers`. Controllers register on the FastAPI
router in `api/main.py`.

| Module | Owns |
|---|---|
| `Admin` | Store settings, team, owner invites, tax export |
| `Announcements` | Global banner system + email broadcast |
| `Audit` | Operator + superadmin audit logs, transfer audit |
| `Auth` | Login (password + TOTP + passkey), JWT issuance, password reset, notifications prefs |
| `BankSync` | Stripe Financial Connections, `BankTransaction`, `BankRule`, `BUILTIN_BANK_RULES` |
| `Batches` | ACH batch CRUD + linked transfers |
| `Billing` | Stripe checkout, subscriptions, addons, referrals, data retention |
| `Customers` | `find_or_upsert_customer`, autocomplete search, `PHONE_COUNTRY_CODES` |
| `DailyBook` | Daily report, line items, drops, deposits |
| `Dashboard` | Per-role landing data |
| `FeatureFlags` | Per-store overrides + global defaults |
| `Monthly` | P&L with the bank-fed lines (see Bank feed → books) + the store's own names for its P&L lines |
| `Notifications` | SMTP send, email templates, trial reminders, locked-day digest |
| `Owners` | Multi-store owner umbrella + dashboard rollup |
| `ReportImport` | Parse remittance-company daily close reports (Intermex first) — deterministic text-layer parse, no OCR/vision — + commit reviewed giros into the day's MT breakdown |
| `Reports` | Per-store + platform reports, CSV exports (registry-driven) |
| `ReturnChecks` | Returned-check tracking + payments |
| `Superadmin` | `/superadmin/*` controls, anomalies, BI reports |
| `Support` | In-app support tickets (admin → superadmin) |
| `Tenancy` | `Store`, `User`, `StoreEmployee`, `StoreOwnerLink`, `OwnerConnectCode` |
| `TimeClock` | Employee shift clock-in / clock-out + admin payroll history |
| `Transfers` | Transfer CRUD + cancellation flow |
| `TVDisplay` | Rate-board addon, public display, Fire TV pairing |
| `Webhooks` | Stripe + Resend ingest |

Cross-cutting (under `api/Core/`):

| Module | Owns |
|---|---|
| `Audit` | `audit_operator`, `audit_superadmin`, `@audit_action` decorator — claims-aware wrappers around the recorder Services |
| `Boot` | `init_db()`, `warn_default_seed_passwords()` — called from `api/main.py` lifespan |
| `Bootstrap` | Alembic upgrade, index safety-net, legacy backfills |
| `Clock` | `utc_now()` — canonical UTC timestamp (single point to flip when migrating to tz-aware) |
| `Config` | Pydantic-settings env loader |
| `Csv` | `build_csv(headers, rows)` — string-based CSV construction helper |
| `Database` | SQLAlchemy engine + `SessionLocal` + `get_db` FastAPI dep |
| `Jobs` | RQ-backed ``enqueue(fn, *args)`` with sync fallback |
| `Observability` | structlog config, Sentry init, `RequestIDMiddleware`, `SecurityHeadersMiddleware` (CSP + frame options) |
| `Pagination` | `PaginationParams` + `paginate()` + `paginate_list()` — shared list-endpoint envelope |
| `PasswordHash` | bcrypt wrappers used by signup + change-password |
| `Permissions` | Casbin-backed RBAC — `check_permission`, `permissions_for`, `set_store_permissions`, the rank rule (`ranks.py`), the one matrix-route path (`matrix_update.py`) |
| `RateLimit` | slowapi singleton + decorator |

Top-level files:

| File | Owns |
|---|---|
| `asgi.py` | Production ASGI router — FastAPI mount, SPA shell, `/static/`, PublicRoutes, cutover redirects |
| `api/main.py` | `create_app()` factory + lifespan + router registration |
| `api/spa.py` | Vite build serve (`/app/*`) |
| `api/PublicRoutes.py` | Landing, PWA, TV display, pair-code API |
| `api/SpaCutover.py` | Pure `redirect_target(path, qs)` for legacy URLs |
| `tests/_app.py` | Test-only re-export shim (`db`, `flask_app` stub, helpers) |

## Templates and static files
Every page, logged-in or not (landing, login, signup, 2FA, privacy),
is an SPA route. What is left server-side:
- `templates/offline.html` — the service worker's offline page.
- `templates/tv_display_public.html` — the public TV rate board.
- `templates/emails/` — transactional email bodies.
- `static/design-tokens.css` — dark+neon tokens + legacy aliases.
  **New tokens go here.**
- `static/sw.js` — the service worker. Every file in its `SHELL`
  precache list must exist (`tests/test_service_worker_shell.py`):
  one 404 and nothing is cached, not even the offline page.

## OpenAPI → TypeScript types
The SPA reads request/response shapes from
`frontend/src/api/openapi.d.ts`, a file generated by
`openapi-typescript` from the FastAPI app's runtime OpenAPI spec.
**Don't edit it by hand.** Regenerate any time you change a
Pydantic schema or add/rename a route:

```bash
cd frontend && npm run generate-types
```

That chains `python -m scripts.dump_openapi` (dumps
`api_app.openapi()` to `openapi.json`) with `openapi-typescript`
(turns the JSON into the `.d.ts`). Both files are checked in
so the SPA build doesn't need a live backend. There's no CI
gate enforcing sync — regenerate after Pydantic-schema edits as
part of your normal commit. If the committed `.d.ts` is stale,
TypeScript will catch the drift at the call site when you
import a renamed/removed field.

Consume the types via `import type { components } from "./openapi"`:

```typescript
import type { components } from "./openapi";
type AnnouncementRow = components["schemas"]["AnnouncementRow"];
```

New code should use this pattern instead of hand-writing
interfaces. The `frontend/src/api/*.ts` files that still hand-write
their types migrate on-touch; `announcements.ts` is the canonical
example.

## Tests
```bash
pytest tests/          # ~3,400 tests currently
pytest tests/ -x -q    # stop on first failure, quiet
```
Fixtures live in `tests/conftest.py` and set up an in-memory SQLite with
a seeded superadmin + one trial store. **When I add features via chat
smoke tests, those need to graduate into committed tests** — tracked in
BACKLOG.md.

## mypy — strict ratchet

```bash
python -m mypy   # runs against the curated file list in pyproject.toml
```

E5 (BACKLOG.md) — `pyproject.toml` enumerates the files held to
`--strict`. The rest of the tree is unchecked.  **Adding a file to the
ratchet** is the workflow:

1. Run `python -m mypy --strict --follow-imports=silent path/to/file.py`
   from the repo root.
2. Fix what fires (or add targeted `# type: ignore[error-code]` for
   the genuinely-untyped third-party seams).
3. Append the path to the `files = [...]` list in `pyproject.toml`.
4. `python -m mypy` (no args) re-runs the full ratchet — CI runs the
   same command.

Known traps:
- **SQLAlchemy 1.x `Column(...)` declarations** report attributes as
  `Column[T]` instead of `T`, which trips every assignment on a service
  that touches ORM rows. Either migrate the model to `Mapped[T] =
  mapped_column(...)` first (own PR) or keep the service out of the
  ratchet for now.
- **FastAPI `@router.<verb>(...)` decorators** fire `untyped-decorator`
  in older FastAPI stubs. Quarantined until we pin a newer FastAPI or
  selectively `# type: ignore[misc]`.

## Git & PR workflow
- Work on `claude/add-subscription-management-LdGPx` (the project's
  long-running feature branch) unless told otherwise. Sync from `main`
  before starting: `git pull --ff-only origin main`.
- One commit per coherent change. Commit messages explain *why*, not
  *what*; include a short "test plan" in PR descriptions.
- Never push to `main`. Always open a PR.
- Never bypass hooks (`--no-verify`, `--no-gpg-sign`) unless asked.

## What NOT to do
- ❌ Write a component, hook, helper or CSS block without first
  checking whether one exists — read
  `frontend/src/components/ui/index.tsx` and grep for the concept
  (UI-STANDARDS §6). A hand-rolled month grid, money input, tab
  strip, confirm dialog or table-with-loading-states is a change
  request.
- ❌ Extract a shared component for a NEW page while leaving the
  existing copy in place — move every caller onto it in the same PR
  or you have added a maintenance burden, not removed one.
- ❌ Inline-style hex colors — use a `--db-*` token.
- ❌ Drop columns or tables from a running DB without a backfill
  step (rename in one revision, copy data, drop in a follow-up).
- ❌ Skip audit logging on a superadmin / admin mutation — use
  `audit_superadmin(db, user, ...)` or `audit_operator(db, claims, ...)`
  from `api.Core.Audit`.
- ❌ Remove `allow_promotion_codes=True` from Stripe checkout.
- ❌ Use `Model.query.get(id)` — use `db.session.get(Model, id)`.
- ❌ Add a new `Store.plan` value without updating `get_trial_status`
  and the trial context processor.
- ❌ Add a per-store data model without adding it to the
  retention-purge list in `api/Modules/Billing/Services/retention.py`.
- ❌ Add inline SQL in a Controller when a Repository helper exists
  (or could exist) — Owners, Superadmin, Admin, Transfers, Auth,
  TimeClock all have `Repositories/` packages.
- ❌ Commit without `pytest tests/` passing AND `python -m mypy` clean.
- ❌ Leak the raw password-reset token to the DB or logs on success —
  only log on SMTP-fallback and only the URL.
- ❌ Inline `db.query(...)` queries inside `Casbin` permission checks —
  use the `api.Core.Permissions` API (`check_permission`,
  `permissions_for`, `set_store_permissions`, etc.) so the Casbin
  enforcer singleton stays the only direct caller.

## Deferred work
See `BACKLOG.md`. Items under **Before going live** are gates for public
launch; the rest can land on any cadence.

## PR monitoring — auto-subscribe, auto-fix CI, address comments

For every PR you open (or find open) on a branch you're working on in this
repo, **automatically call `subscribe_pr_activity`** without asking first.
Do not ask "would you like me to watch this PR?" — just subscribe.

When PR activity events arrive:

- **CI failures (`get_check_runs` shows failing jobs, or a webhook event
  reports a failed check):** investigate the failing job's logs, push a fix
  commit to the same branch, and report what you changed. If the failure
  is flaky or outside the PR's scope, say so and skip rather than guessing.
- **Review comments (review threads, PR comments):** for each unresolved
  thread, read the comment, assess whether the suggestion is correct, and
  either (a) push a fix and reply briefly, or (b) reply with why the
  suggestion doesn't apply. Use `AskUserQuestion` only when a comment is
  genuinely ambiguous or would require a large refactor.
- Never skip hooks or force-push to address CI failures — fix the
  underlying problem.
- Stay on the PR's branch; never push unrelated changes.

When there is no open PR for the current branch and the user is done with
a set of changes, offer to open one so CI can run.

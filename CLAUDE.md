# DineroBook — Engineering Context

> Read automatically at the start of every session. Every rule here is
> binding; the goal is **no quiet regressions**. Keep this file short:
> detail lives next to the code it governs, in `CLAUDE.md` files that
> Claude Code loads by itself the moment it reads a file in that folder.
>
> | Folder | Its `CLAUDE.md` holds |
> |---|---|
> | [`api/`](api/CLAUDE.md) | module map, `api/Core` helpers, the detail behind the backend invariants below, mypy ratchet, templates |
> | `api/Modules/{Auth,BankSync,DailyBook,Monthly,Transfers}/` | that module's `INVARIANTS.md` (imported, so it is always in view) |
> | [`api/Modules/Customers/`](api/Modules/Customers/CLAUDE.md) | the Transfers invariants (customer upsert) |
> | [`frontend/`](frontend/CLAUDE.md) | design system, UI standards, OpenAPI types, the SPA checks CI runs |
> | [`alembic/`](alembic/CLAUDE.md) | migrations and table naming |
>
> `tests/test_instruction_files.py` fails when a key rule disappears
> from these files or a path they name stops existing. A new rule goes
> in the file nearest the code it governs, plus a one-liner here when
> every change must respect it.
>
> **New account / picking up in-flight work?** Read
> [`HANDOFF.md`](HANDOFF.md) too — roadmap, known unfixed bugs and
> pre-launch ops gates.

## What this is
A multi-tenant bookkeeping SaaS for money-service businesses (MSBs —
small shops that send remittances via Intermex / Maxi / Barri and keep
a daily cash ledger + monthly P&L), pivoting toward a back office for
convenience stores and gas stations. Each **Store** has admins +
employees; multi-store **Owners** connect via invite codes; the
platform runs under one **Superadmin**.

**It is live with paying customers. Every merge to `main` deploys
straight to production** — nothing may break sign-in or daily use.

## Stack
- FastAPI / Starlette on ASGI; `asgi.py` is the single entry point
  (Flask was removed in PR #550 — `app.py`, `blueprints/`, `api/Flask/`
  are gone). Routes live in `api/Modules/<domain>/Controllers/`.
- SQLAlchemy, SQLite in tests/dev, Postgres in prod. **Alembic is the
  sole source of schema truth** (`alembic/CLAUDE.md`).
- React 19 SPA (Vite) under `frontend/` is the whole UI. Jinja2 survives
  only for `templates/offline.html`, `templates/tv_display_public.html`
  and `templates/emails/`.
- Stripe (Checkout, Billing Portal, webhooks, Financial Connections).
- Casbin RBAC, live enforcement, one transactional writer — see
  `api/Modules/Auth/INVARIANTS.md` before touching permissions.
- pytest for Python; Vitest + Testing Library for the SPA.

## Production deploy target (single source of truth)
- **Web service**: `dinerobook` on Render → `https://dinerobook.com`
  (the `dinerobook.onrender.com` hostname is no longer canonical).
- **Database**: `dinerobook-db` on Render (`fromDatabase:` in `render.yaml`).
- The older `cashnet` service / `cambio-db` database are decommissioned.
  Never add references to them, never point env vars at them, never run
  migrations against them. A new service must be declared in
  `render.yaml` and auto-deploy from `main`.

## Before you commit
```bash
pytest tests/ -q                     # ~4,500 tests
python -m mypy                       # strict ratchet (api/CLAUDE.md)
cd frontend && npm run lint -- --max-warnings 0 && npm run build && npx vitest run
```
All three must be clean. `npm run build` (not `tsc --noEmit`) is the
type check CI runs; delete `frontend/dist` afterwards. Running the app
locally, seed logins and the cron scripts: `api/CLAUDE.md`.

## Git & PR workflow
- Develop on the branch the session names; never push to `main`.
  Sync from `main` first. One squashed PR per theme; ask the owner
  before merging ("merge when green" / "Yes" is the approval).
- Commit messages explain *why*; PR descriptions carry a test plan.
  Auth changes get an explicit review header in the PR description.
- Never bypass hooks (`--no-verify`, `--no-gpg-sign`) unless asked.
- DB changes are additive and backwards compatible; new behaviour is
  opt-in. Say so in the PR when something can't meet that.

## Critical invariants — don't break these
Numbered because code and tests cite them ("invariant 19"). The detail
is in the file named after the arrow.

1. **Design system is the source of truth** — dark by default, neon
   `#3fff00` the only accent, Space Grotesk + Inter + JetBrains Mono,
   semantic `--db-*` tokens, reuse the kit before building.
   → `frontend/CLAUDE.md`, `docs/design-system/UI-STANDARDS.md`
2. **Sidebar** is ONE table, `NAV` in
   `frontend/src/components/navConfig.tsx`; a new page joins exactly
   one group and gets its access row in `frontend/src/lib/access.ts`.
   → `frontend/CLAUDE.md`
3. **Trial state machine** — `Store.plan ∈ {trial, basic, pro,
   inactive}`; routes reachable after expiry are listed in
   `_TRIAL_EXEMPT`. → `api/CLAUDE.md`
4. **Data retention** — every per-store model goes in
   `_STORE_OWNED_MODELS` (`api/Modules/Billing/Services/retention.py`)
   so `purge_expired_stores()` cascades. → `api/CLAUDE.md`
5. **Customer upsert** — `find_or_upsert_customer()` is the only path
   that creates or updates `Customer` rows from the transfer form,
   scoped to the owner umbrella. → `api/CLAUDE.md`,
   `api/Modules/Transfers/INVARIANTS.md`
6. **Feature flags** — `store_feature_enabled()` resolves per-store →
   global default → fail-open; declare defaults in
   `_DEFAULT_FEATURE_FLAGS`. → `api/CLAUDE.md`
7. **Audit log** — every superadmin mutation calls `record_audit(...)`
   (`audit_superadmin` / `audit_operator` from `api.Core.Audit`).
8. **Stripe checkout** keeps `allow_promotion_codes=True` — discount
   redemption depends on it.
9. **Fee vs federal tax** — `Transfer.total_collected = send_amount +
   fee + federal_tax`; `ACHBatch.transfers_total = Σ (send_amount +
   federal_tax)`. → `api/Modules/Transfers/INVARIANTS.md`
10. **Password reset** — tokens stored as `sha256(raw)`, single-use,
    1-hour expiry; `/forgot-password` never reveals whether an account
    exists; superadmin is excluded from the email flow.
    → `api/Modules/Auth/CLAUDE.md`
11. **`db.session.get(Model, id)`** — never `Model.query.get(id)`.
12. **Referrals** — one `ReferralCode` per store, credits applied once
    in the `checkout.session.completed` webhook. → `api/CLAUDE.md`
13. **2FA (TOTP) is mandatory for superadmin** — only the 2FA finalize
    step may turn a pending sign-in into full access; `needs_totp()`
    (`api/Modules/Auth/Services/totp.py`) is the single role gate; a
    passkey login (not built yet) is the one future carve-out.
    → `api/Modules/Auth/CLAUDE.md`
14. **Every paginated table live-searches** through
    `useUrlFilterState` (300 ms, 2-char minimum, filters in the URL)
    on the kit `<DataTable>`. → `frontend/CLAUDE.md`
15. **Rate limiting** on every auth, password-reset and webhook route,
    keyed by `client_ip` (rightmost `X-Forwarded-For`). → `api/CLAUDE.md`
16. **Slow work goes through `api.Core.Jobs.enqueue(...)`** with
    primitive args and top-level worker functions. → `api/CLAUDE.md`
17. **CSRF** — the sign-in cookie is `SameSite=Lax`, so **no GET route
    may change state**. → `api/CLAUDE.md`
18. **The rank rule and the live principal** — every route that changes
    another person's role, password, active flag or access goes through
    `api/Core/Permissions/ranks.py`; `get_principal` checks the DB on
    every request. → `api/Modules/Auth/CLAUDE.md`
19. **A store id from the client is a request, not a scope** — run it
    through `authorize_store_id(s)` (`api.Core.StoreScope`).
    → `api/CLAUDE.md`
20. **Every route needs a signed-in caller** unless it is on the
    `PUBLIC` list in `tests/Core/test_route_auth.py` (with a rate limit).
21. **Number fields refuse NaN and Infinity** —
    `ConfigDict(allow_inf_nan=False)` on every request model with a
    `float`. → `api/CLAUDE.md`
22. **Security headers leave with every response** —
    `with_page_security_headers` in `asgi.py`. → `api/CLAUDE.md`

Money modules carry an `INVARIANTS.md` (Auth, BankSync, DailyBook,
Monthly, Transfers). It loads with that module's `CLAUDE.md`; the SPA
files that count as part of a module are listed in `frontend/CLAUDE.md`.

## What NOT to do
- ❌ Write a component, hook, helper or CSS block without first checking
  whether one exists (`frontend/src/components/ui/index.tsx`, grep the
  concept — UI-STANDARDS §6). Two copies is the extraction threshold.
- ❌ Extract a shared component for a NEW page while leaving the existing
  copy in place — move every caller onto it in the same PR.
- ❌ Make something consistent across the app without writing the rule
  into `docs/design-system/UI-STANDARDS.md` (and here when binding) in
  the same PR.
- ❌ Inline-style hex colors — use a `--db-*` token.
- ❌ Drop columns or tables from a running DB without a backfill step.
- ❌ Import application code in a migration.
- ❌ Skip audit logging on a superadmin / admin mutation.
- ❌ Remove `allow_promotion_codes=True` from Stripe checkout.
- ❌ Use `Model.query.get(id)`.
- ❌ Add a new `Store.plan` value without updating `get_trial_status`
  and the trial context processor.
- ❌ Add a per-store model without adding it to the retention-purge list.
- ❌ Add inline SQL in a Controller when a Repository helper exists (or
  could exist).
- ❌ Hand-write a store-scope 403, a `strptime` date parse or a report
  period in a controller (`resolve_store_scope`, `parse_iso_day`,
  `resolve_period`), or call `datetime.utcnow()` (use `utc_now()`).
- ❌ Commit without `pytest tests/`, `python -m mypy` and the SPA checks
  clean.
- ❌ Leak the raw password-reset token to the DB or logs.
- ❌ Query Casbin tables directly — use the `api.Core.Permissions` API.
- ❌ Skip, disable or quarantine a test to get green.
- ❌ Add references to the decommissioned `cashnet` / `cambio-db`.

## Deferred work
`BACKLOG.md`. Items under **Before going live** are gates for public
launch; the rest can land on any cadence.

## PR monitoring — auto-subscribe, auto-fix CI, address comments
For every PR you open (or find open) on a branch you're working on in
this repo, **automatically call `subscribe_pr_activity`** without asking.

When PR activity events arrive:
- **CI failures:** read the failing job's logs, push a fix commit to the
  same branch, and report what you changed. If the failure is flaky or
  outside the PR's scope, say so and skip rather than guessing.
- **Review comments:** for each unresolved thread, either push a fix and
  reply briefly, or reply with why the suggestion doesn't apply. Ask the
  owner only when a comment is genuinely ambiguous or needs a large
  refactor.
- Never skip hooks or force-push to address CI failures — fix the
  underlying problem.
- Stay on the PR's branch; never push unrelated changes.

When there is no open PR for the current branch and the user is done
with a set of changes, offer to open one so CI can run.

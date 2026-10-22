# Backend — rules and map

> Loaded automatically when Claude reads a file under `api/`. The root
> `CLAUDE.md` keeps the one-line version of each invariant; this file
> holds the detail. A module with money rules also has its own
> `CLAUDE.md` + `INVARIANTS.md` — read it before editing that module.

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
python -m scripts.backfill_federal_tax       # one-shot — recompute Transfer.federal_tax (only when the owner asks)
```
Set `DEV_RELOAD=1` for hot-reload on Python edits. The Vite dev server
(port 5173) handles SPA reload on its own.

**Prefer Postgres for dev** (parity with prod):
```bash
docker compose up -d          # local Postgres 16 on 127.0.0.1:5432
export DATABASE_URL=postgresql://dinerobook:dinerobook@localhost:5432/dinerobook
uvicorn asgi:asgi_app --reload --port 5000
```
`docker compose --profile queue up -d` also starts Redis for the job
queue (then set `JOB_QUEUE_ENABLED=1` + `REDIS_URL`). The `Dockerfile`
builds the full production image; Render doesn't use it (it runs the
native Python service from `render.yaml`) — it exists so the app stays
portable.

First boot seeds a superadmin (`superadmin / super2025!`) and demo store
admin (`admin / cambio2025!`). Override via `SUPERADMIN_PASSWORD` /
`ADMIN_PASSWORD` env vars in prod.

Passkey env (optional): `WEBAUTHN_RP_ID` pins the WebAuthn Relying Party
ID in prod (`dinerobook.com`). Dev falls back to `request.host` with the
port stripped. **Changing this value invalidates every existing
passkey** — they're bound to the rpId active at registration.

## Tests
Fixtures live in `tests/conftest.py`: an in-memory SQLite with a seeded
superadmin + one trial store. Features smoke-tested in chat must
graduate into committed tests (tracked in `BACKLOG.md`). Every change
carries grant / deny / success / failure tests.

## Invariant detail

**3. Trial state machine** — `Store.plan ∈ {trial, basic, pro,
inactive}`. `get_trial_status(store)` returns `active | expiring_soon |
grace | expired | exempt`. Routes allowed during `expired` are
enumerated in `_TRIAL_EXEMPT` — extend it when you add routes that must
stay reachable after the trial ends (subscribe, logout, billing portal,
cancel, admin_subscription, password-reset routes).

**4. Data retention** — on Stripe `customer.subscription.deleted` we set
`Store.data_retention_until = now + 180 days`; on resubscribe
(`checkout.session.completed`) we clear it. `purge_expired_stores()`
cascades through every per-store table (`_STORE_OWNED_MODELS` in
`api/Modules/Billing/Services/retention.py`) before deleting the
`Store` row. Add new per-store models to that list.

**5. Customer upsert (owner umbrella scope)** —
`find_or_upsert_customer()` is the only path that creates or updates
`Customer` rows from the transfer form. Lookup order:
1. explicit `customer_id` (only reused if the target customer lives in
   a sibling store — the current store's owner umbrella);
2. `(phone_country, phone_number)` across **every store that shares an
   owner with the current store** via `sibling_store_ids()` — so a
   cashier at Store B finds the sender that Store A logged;
3. else create a new record pinned to the current `store_id`.

A Customer row always stays pinned to its home store; transfers at
sibling stores point `customer_id` at it (no duplication). Newest
values overwrite. Unrelated stores (no owner overlap) stay isolated.

**6. Feature flags** — `store_feature_enabled(store, key)` resolves
per-store override → global default → **fail-open** (undeclared flag
returns True). New optional features gate on `addon_<key>` (add-ons) or
a descriptive key (`bank_sync`, `multi_store_owner`). Declare defaults
in `_DEFAULT_FEATURE_FLAGS`.

**7. Audit log** — every superadmin mutation calls `record_audit(action,
target_type, target_id, details)`; use `audit_superadmin(db, user, ...)`
or `audit_operator(db, claims, ...)` from `api.Core.Audit`. Don't commit
a superadmin route that mutates state without an audit entry.

**12. Referrals** — `ReferralCode` is one-per-store, minted lazily by
`ensure_referral_code(store)` when an admin on a paid plan loads any
page and explicitly by the `checkout.session.completed` webhook.
Credits are applied by `apply_pending_referral_credits(referee_store)`
in that webhook — $50 to the referee, $100 to the referrer, via Stripe
`create_balance_transaction`. Idempotent: `ReferralRedemption` is the
lockout row and `Store.referee_credit_applied_at` gates retries. The
topbar crown reads `my_referral_code` — empty string hides it.

**15. Rate limiting** — every auth route, password-reset route and
webhook ingest endpoint is bucketed by slowapi.
- Shared singleton in `api/Core/RateLimit.py`. Endpoints carry
  `@_rate_limiter.limit(...)` (`from api.Core.RateLimit import limiter
  as _rate_limiter`).
- Limits count per client address: `client_ip`, the RIGHTMOST
  `X-Forwarded-For` entry (the one Render's proxy appended — entries
  left of it are client-written and forgeable), else the socket peer.
  Keying on the socket peer put every customer behind Render's proxy
  into one shared bucket. Public Starlette routes (`api/PublicRoutes.py`)
  use the same limiter. Any address we show or store (Account → Devices,
  sign-in alerts) comes from the same `client_ip`.
- Storage defaults to in-memory; prod sets `RATELIMIT_STORAGE_URI=redis://...`
  in `render.yaml`. `RATELIMIT_ENABLED=0` disables the limiter (the test
  conftest sets it — never in prod).
- slowapi captures `enabled` at import time; tests that exercise the 429
  path spawn a subprocess (`tests/test_rate_limiting.py`).
- Don't tighten limits casually — integration tests and Stripe webhook
  retries burn budget. Loosening is always safer.

**16. Background-job queue** — heavy / slow work in a request handler
goes through `api.Core.Jobs.enqueue(...)`, not a direct call: SMTP sends
(`send_password_reset_email`), Stripe round-trips that needn't land
before the response, anything that fans out to N recipients.
- Opt-in via `JOB_QUEUE_ENABLED=1` + `REDIS_URL` on web + worker; either
  missing → synchronous (the default; same semantics as a direct call).
- The worker service is staged, commented, in `render.yaml` with its
  activation runbook.
- Args MUST be primitives (ids, dicts, strings), never ORM objects;
  workers open their own `SessionLocal`. Worker functions are top-level
  so RQ can pickle them.
- `tests/Core/test_jobs.py` covers sync, queued and partial-env modes.

**17. CSRF** — the SPA signs in with an httpOnly `db_access_token`
cookie (plus `Bearer` for scripts/tests), so the CSRF defence is the
cookie's `SameSite=Lax`: a browser never sends it on another site's
POST / PUT / PATCH / DELETE. That holds only while **no GET route
changes state**. Webhooks verify provider signatures (Stripe
`Stripe-Signature`, Resend HMAC). Never loosen the cookie to
`SameSite=None`; a cookie-authenticated HTML form POST needs a CSRF
token.

**19. A store id from the client is a request, not a scope.** Any route
that reads `store_id` / `store_ids` from the URL or query string runs it
through `api.Core.StoreScope` (`authorize_store_id` /
`authorize_store_ids`) before touching data: admins and employees get
only the store on their token, owners only their umbrella, superadmin
any; outside that is a 403. The token's OWN store is
`resolve_store_scope(claims)` (`Auth/Services/principal.py`).
`tests/Core/test_store_scope_routes.py` walks every such route.

**20. Signed-in callers only** — `tests/Core/test_route_auth.py` walks
the live router and expects 401 from every route a stranger calls,
except its `PUBLIC` table (sign-in and recovery, sign-up, price list,
liveness, webhooks). A new public route goes on that list in the same
PR, with a rate limit.

**21. NaN / Infinity** — every request model with a `float` carries
`ConfigDict(allow_inf_nan=False)` (`tests/Core/test_request_bodies.py`
walks them); the 422 handler in `api/main.py` echoes such a value back
as text.

**22. Security headers** on every response — API, SPA shell, landing,
TV board, `/static`. `asgi.py` wraps the router in
`with_page_security_headers`
(`api/Core/Observability/security_headers.py`); the API keeps its full
CSP, pages carry framing / base / plugin rules. A script allowlist on
pages must be tried against the live Stripe bank-connect flow first.

## Module map (`api/Modules`)
Every domain owns four layers: `Models`, `Repositories`, `Services`,
`Controllers`. Controllers register on the router in `api/main.py`.

| Module | Owns |
|---|---|
| `Admin` | Store settings, employees, owner invites, tax export |
| `Announcements` | Global banner system + email broadcast |
| `Audit` | Operator + superadmin audit logs, transfer audit |
| `Auth` | Login (password + TOTP + passkey), JWT issuance, password reset, sessions, notification prefs |
| `BankSync` | Stripe Financial Connections, `BankTransaction`, `BankRule`, `BUILTIN_BANK_RULES` |
| `Batches` | ACH batch CRUD + linked transfers |
| `Billing` | Stripe checkout, subscriptions, add-ons, referrals, data retention |
| `Customers` | `find_or_upsert_customer`, autocomplete search, `PHONE_COUNTRY_CODES` |
| `DailyBook` | Daily report, line items, drops, deposits |
| `Dashboard` | Per-role landing data |
| `FeatureFlags` | Per-store overrides + global defaults |
| `Monthly` | P&L with the bank-fed lines + the store's own names for its P&L lines |
| `Notifications` | SMTP send, email templates, push, trial reminders, digests, sign-in alerts |
| `Owners` | Multi-store owner umbrella + dashboard rollup |
| `ReportImport` | Parse remittance-company daily close reports (Intermex first; deterministic text-layer parse, no OCR) + commit reviewed giros into the day's MT breakdown |
| `Reports` | Per-store + platform reports, CSV exports (registry-driven) |
| `ReturnChecks` | Returned-check tracking + payments |
| `Superadmin` | `/superadmin/*` controls, anomalies, BI reports |
| `Support` | In-app support tickets (admin → superadmin) |
| `Tenancy` | `Store`, `User`, `StoreEmployee`, `StoreOwnerLink`, `OwnerConnectCode` |
| `TimeClock` | Shift clock-in / clock-out + admin payroll history |
| `Transfers` | Transfer CRUD + cancellation flow |
| `TVDisplay` | Rate-board add-on, public display, Fire TV pairing |
| `Webhooks` | Stripe + Resend ingest |

Retail modules (`DayClose`, `StoreBook`, `Lottery`, `PosImport`,
`Catalog`) follow the same layout.

## Cross-cutting (`api/Core/`)

| Module | Owns |
|---|---|
| `Audit` | `audit_operator`, `audit_superadmin`, `@audit_action` — claims-aware wrappers around the recorder Services |
| `Boot` | `init_db()`, `warn_default_seed_passwords()`, `warn_default_signing_secret()` — called from the `api/main.py` lifespan |
| `Bootstrap` | Alembic upgrade, index safety-net, legacy backfills |
| `Clock` | `utc_now()` (the one UTC timestamp); `store_local_today`; `parse_iso_day` (a `YYYY-MM-DD` value or a 422 naming the field — never hand-write `strptime` in a controller); `resolve_period` (a report's `from`/`to`). `tests/Core/test_one_copy_helpers.py` holds the line |
| `Config` | Pydantic-settings env loader |
| `Csv` | `build_csv(headers, rows)` |
| `Database` | SQLAlchemy engine + `SessionLocal` + `get_db` dependency |
| `Jobs` | RQ-backed `enqueue(fn, *args)` with sync fallback |
| `Observability` | structlog, Sentry, `RequestIDMiddleware`, `SecurityHeadersMiddleware`, `with_page_security_headers` |
| `Pagination` | `PaginationParams` + `paginate()` + `paginate_list()` — the list-endpoint envelope |
| `PasswordHash` | bcrypt wrappers |
| `Permissions` | Casbin RBAC — `check_permission`, `permissions_for`, `set_store_permissions`, the rank rule (`ranks.py`), the one matrix-route path (`matrix_update.py`) |
| `RateLimit` | slowapi singleton + `client_ip` |
| `StoreScope` | `authorize_store_id(s)` — which stores a client-supplied id may reach (invariant 19). The token's own store is `resolve_store_scope(claims)`; never re-write that 403 inline |

Top-level files:

| File | Owns |
|---|---|
| `asgi.py` | Production ASGI router — FastAPI mount, SPA shell, `/static/`, PublicRoutes, cutover redirects |
| `api/main.py` | `create_app()` + lifespan + router registration |
| `api/spa.py` | Vite build serve (`/app/*`) |
| `api/PublicRoutes.py` | Landing, PWA, TV display, pair-code API |
| `api/SpaCutover.py` | Pure `redirect_target(path, qs)` for legacy URLs |
| `tests/_app.py` | Test-only re-export shim (`db`, helpers) |

## Templates and static files
Every page, logged-in or not, is an SPA route. Server-side leftovers:
- `templates/offline.html` — the service worker's offline page.
- `templates/tv_display_public.html` — the public TV rate board.
- `templates/emails/` — transactional email bodies.
- `static/design-tokens.css` — dark+neon tokens + legacy aliases.
  **New tokens go here.**
- `static/sw.js` — the service worker. Every file in its `SHELL`
  precache list must exist (`tests/test_service_worker_shell.py`): one
  404 and nothing is cached, not even the offline page.

## mypy — strict ratchet
```bash
python -m mypy   # runs against the curated file list in pyproject.toml
```
`pyproject.toml` enumerates the files held to `--strict`; the rest is
unchecked. **Adding a file to the ratchet:**
1. `python -m mypy --strict --follow-imports=silent path/to/file.py`
2. Fix what fires (targeted `# type: ignore[error-code]` only for
   untyped third-party seams).
3. Append the path to `files = [...]` in `pyproject.toml`.
4. `python -m mypy` re-runs the full ratchet — CI runs the same command.

Known traps:
- **SQLAlchemy `Column(...)` declarations** type attributes as
  `Column[T]`, which trips every assignment in a service that touches
  ORM rows. Migrate the model to `Mapped[T] = mapped_column(...)` first
  (own PR) or keep the service out of the ratchet.
- **FastAPI `@router.<verb>(...)`** fires `untyped-decorator` in older
  stubs — quarantined.

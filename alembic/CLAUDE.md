# Migrations and table naming

> Loaded automatically when Claude reads a file under `alembic/`. The
> same rules bind anyone changing a model in `api/Modules/*/Models`.

## Every schema change is an Alembic revision
```bash
alembic revision --autogenerate -m "add foo.bar"
```
Review and edit the generated file in `alembic/versions/` —
autogenerate misses data backfills and SQLite batch-mode quirks; read
every line before committing.

`init_db()` runs `alembic upgrade head` on boot — the sole schema
mechanism. Fresh DBs are built by the baseline + every revision;
existing DBs upgrade in place. There is no `db.create_all()` and no
`_ADDED_COLUMNS` list.

- **Additive and backwards compatible.** New columns are nullable or
  carry a server default; new behaviour is opt-in. Idempotent revisions
  (check the column / table exists first) survive a replay.
- **Never drop a column from a running database without a backfill
  step** — rename it in one revision, copy the data, drop the old
  column in a follow-up once the dual-write window has passed.
- **A migration NEVER imports application code.** Spell the columns out
  literally, even when a model already has the list:
  1. A migration is immutable history. If it derives its columns from a
     model, renaming a field later silently changes what that
     historical revision creates — a database rebuilt from scratch
     stops matching one migrated in place.
  2. Alembic imports every file in `alembic/versions/` to build the
     revision graph, and `init_db()` runs that at boot — a top-level
     `from api.…` drags the model layer into the boot path.

  When a literal list could drift from a model, add a test that asserts
  the two agree and that the migration imports no application code (see
  `tests/Modules/StoreBook/test_migration_matches_model.py`).

## Every table carries its area prefix
Every application table is named `<area>_<thing>`. The prefix says
which part of the product owns the table, which module folder it lives
in, and which `INVARIANTS.md` to read before touching it. It is an
*area*, not a tenancy marker — whether a row is pinned to one store is
already on the row as `store_id`.

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

The map is `MODULE_PREFIX` in `api/Core/Schema.py`; the generated map of
every table (module, scope, foreign keys, which INVARIANTS to read) is
[`docs/SCHEMA.md`](../docs/SCHEMA.md).

- **Adding a table:** name it with its module's prefix, run
  `python -m scripts.dump_schema_doc` and commit the regenerated
  `docs/SCHEMA.md`. A per-store table also goes in the retention-purge
  list (`api/Modules/Billing/Services/retention.py`).
- **Adding a module:** add it to `MODULE_PREFIX`.
- `tests/Core/test_table_prefixes.py` fails on a wrong prefix, an
  unmapped module, or a stale doc. Library-owned tables
  (`alembic_version`, `casbin_rule`) keep their upstream names.

Historical migrations before `c4a9e7d21f08` create the OLD names and are
immutable — the rename revision at that point moves every table, its
`ix_<table>_*` indexes, and (Postgres) its auto-named constraints and
id sequence. Never edit an old revision to use a new name.

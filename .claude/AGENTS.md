# Agent team — shared rules

Read by every subagent in `.claude/agents/` and every command in
`.claude/commands/`. It does **not** repeat the project rules — those
live in the `CLAUDE.md` files and drift when copied. Before any edit:

1. Read the repo-root `CLAUDE.md` (the invariants and "What NOT to do").
2. Read the `CLAUDE.md` of the folder you are editing: `api/CLAUDE.md`
   for backend code, `frontend/CLAUDE.md` for the SPA,
   `alembic/CLAUDE.md` for schema, and `api/Modules/<X>/CLAUDE.md` +
   `INVARIANTS.md` for Auth, BankSync, DailyBook, Monthly, Transfers and
   Customers. Interactive sessions load these automatically; a subagent
   should read them explicitly.

Where the code lives: routes in `api/Modules/<X>/Controllers/`,
business logic in `Services/`, queries in `Repositories/`, shared
helpers in `api/Core/`, the SPA in `frontend/src/` (kit in
`frontend/src/components/ui/`, API clients in `frontend/src/api/`).
There is no `app.py` and no Jinja page templates.

## Style — when editing code

- Don't add features, refactors or abstractions beyond what the task
  requires. Three similar lines beat a premature abstraction; two
  copies of the same thing is where extraction starts (and every
  caller moves onto the helper in the same change).
- Follow the surrounding code's naming, comment density and idiom.
  Comments explain WHY, not WHAT.
- No backwards-compat shims for deletes (`# removed` markers, unused
  re-exports, renamed `_var` placeholders). Delete cleanly.
- No error handling for impossible states. Validate at system
  boundaries (request bodies, webhooks, external APIs); trust internal
  callers.

## Test floor

- Before declaring success, all of these pass:
  ```bash
  pytest tests/ -x -q
  python -m mypy
  cd frontend && npm run lint -- --max-warnings 0 && npm run build && npx vitest run
  ```
  (only the SPA line when `frontend/` changed; delete `frontend/dist`).
- New routes get tests for grant / deny / success / failure. Use the
  fixtures in `tests/conftest.py` (in-memory SQLite, seeded superadmin,
  one trial store) and the helpers there (`login_admin`,
  `make_employee_client`, …).
- Never delete, skip or quarantine a test to make a sweep pass — fix the
  code, or flag the test as a real regression and stop.

## Sweep etiquette (unattended runs)

- **One PR per sweep run**, one concern (dedup OR simplify OR tests).
- **Stop on red.** If the checks above fail after edits, revert and
  report. Don't push broken code.
- **No design drift.** No new tokens, fonts, components or colors. UI
  work needs a human in the loop.
- **No schema changes** (columns, tables, migrations).
- **No new dependencies** (`requirements.txt`, `package.json`).
- **No deletions of routes, models or pages.** Flag them in the PR body
  under "Deferred — needs human review".
- **Never push to `main`; never merge.** The owner approves merges.
- **Diff budget.** Aim for < 400 lines net per sweep PR. Bigger finds go
  in the PR description as "deferred — too large for an unattended
  sweep".

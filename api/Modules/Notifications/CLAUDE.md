# Notifications — rules

> Loaded automatically when Claude reads a file in this folder. The
> module sends email and push (`Services/smtp.py`, `Services/push.py`,
> the digests and reminders) and owns the top-bar bell. Root invariant
> 23 is the one-line version of the bell rules below.

## The bell (owner, 2026-11-04)

The bell in the top bar lists the work waiting for the signed-in person
in the store they are in. Design doc:
https://claude.ai/artifact/Pc5j3drBnTNyPKkLHTLyTq. UI rules:
`docs/design-system/UI-STANDARDS.md` §10.

**How it works.** `GET /api/v2/notifications/bell`
(`Controllers/__init__.py`) calls `build_bell` in
`Services/bell/__init__.py`, which walks the registry `SOURCES`. Each
source the person may see runs one read inside a savepoint; a source
that raises is logged to Sentry and skipped. Items the person dismissed
for today's store day are dropped, the rest sorted overdue first, then
oldest day. Nothing about an item is stored: it is worked out live, so
it disappears the moment its work is done.

**Opt-in.** The per-store flag `notification_bell` (declared off in
`DEFAULT_FEATURE_FLAGS`, resolved with `opt_in_flag_enabled`, which
never fails open). Off → `enabled: false`, no items, dismiss 404s. No
store on the session (superadmin, support, an owner at the umbrella)
→ `enabled: false`.

**Dismissals** are the only rows: `BellDismissal`
(`notify_bell_dismissal`; person, store, item key, store day). One
holds for that store day only, so tomorrow the item is back if it is
still true. `user_id` is not a foreign key on purpose. Each new
dismissal clears the store's rows older than `DISMISSAL_KEEP_DAYS`. A
superadmin "Sign in as" may read the bell but not dismiss (403,
`can_dismiss: false`): hiding a reminder is that person's call.

### Adding a kind of item

1. Add the kind to `BellKind` in `Services/bell/types.py`. A kind is
   `<area>.<thing>`, and it is **never renamed once live**: saved
   dismissals point at it.
2. Write the source in `Services/bell/sources/` and add it to `SOURCES`
   (order = tie-break). It declares `permissions` (every
   `resource.action` needed to FIX the item, at least one, checked
   live), plus `module` (a `module_*` flag, checked against the store
   and the person's own module access) and/or `feature` when the item
   lives behind one.
3. A source **only reads**: no writes, no email, no push, no Stripe, no
   job. One or two indexed queries. It works in the store's day
   (`ctx.today`, the store timezone), never `date.today()`.
4. A source **groups**: "4 bank rows", one item, not four. The key is
   the kind for a grouped item, or `<kind>:<subject>` when each subject
   is dismissed on its own. The dismiss route refuses a key whose kind
   is unknown.
5. Add the item's row to `BELL_ITEMS` in `frontend/src/lib/bellItems.ts`
   (words, icon, link) and run `npm run generate-types`. The SPA table
   is typed by `BellKind`, so a missing row fails the build.
6. Tests in `tests/Modules/Notifications/test_bell.py`: shown when true,
   gone when fixed, hidden without each permission (default role,
   store-level revoke, per-user revoke), hidden with its module or
   feature off, never another store's, dismissed today and back
   tomorrow. `test_bell_registry.py` checks the registry, the SPA
   table and the migration for you.

Email and push stay where they are (the Notifications settings page and
the digests above). The bell never sends anything.

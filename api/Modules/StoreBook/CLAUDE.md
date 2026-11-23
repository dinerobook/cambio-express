# StoreBook — the store daily book (Retail)

> Loaded automatically when Claude reads a file in this folder. The
> SPA side is `frontend/src/routes/StoreBookDay.tsx`,
> `frontend/src/routes/StoreBookMonth.tsx` and
> `frontend/src/api/storebook.ts`.

On screen the page is named **Daily book** (owner, 2026-11-23: "store
hata do, sirf daily book"); the MSB group's book stays "MSB daily
book", so the two never share a name. In code, comments and these
notes "store daily book" still means this Retail page.

One row per store per day (`retail_store_daily_entry`), three columns
that balance: Sales, Tenders, Deposit & balance. Over/short is tenders
minus sales. Money is integer cents.

## The sheet
- `FIELD_GROUPS` (Models) is the one list of lines: it drives the
  page layout, the API and the totals. A new line is a column, an
  entry there, a migration and its `sb.<key>` words in English and
  Spanish. `tests/Modules/StoreBook/test_migration_matches_model.py`
  adds up the lines of every revision; list a new revision in `_LATER`.
- Every money line is added into its column once. **Gross sales is a
  line like any other**: filling it together with Taxable and Non tax
  counts the sales twice. The register never fills it.
- A locked day refuses every edit a person makes (409).

## The register's day close on the sheet
`api/Modules/StoreBook/Services/register_day.py`. Opt-in per store:
flag `register_day_book`, off by default. Read the module's docstring
before changing it; the short version:

- `register_day()` only reads PosImport's movement tables (the
  business-day reports) and the store's departments. `GET
  /storebook/{day}` reports it as `register_day` and writes nothing.
- `POST /storebook/{day}/register` is the one writer
  (`pull_register_day` → `apply_import`). The page calls it when a day
  opens with `register_day.pending`, and from Refresh. A person asked,
  so a locked day is refused.
- **A number a person typed is never replaced**, before or after the
  register's first figure: `apply_import` fills an empty box, follows
  a box it filled itself, and otherwise only records the register's
  figure as the line's original (`retail_store_daily_entry_original`).
- Lines come from department TYPES (Account → Departments), never
  department numbers. Taxable and non taxable come from the tax
  report, not the department report.
- All or nothing: a department number that is not set up, a missing
  report or a tax split that goes negative leaves the day unfilled
  with `problem` set. Never guess a line.
- Payment types arrive as numbers with no names. Only what is known is
  placed (`CARD_PAYMENT_TYPES`); the rest is reported in `unplaced`.
  Closing cash is what a person counted and is never filled.
- The figures were checked to the cent on three days of ONE store.
  Check a second store against its current back office before
  switching the flag on widely (`BACKLOG.md`).

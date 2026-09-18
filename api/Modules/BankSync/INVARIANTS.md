# BankSync — Invariants

> **Read this before editing anything in `api/Modules/BankSync/`,
> `frontend/src/api/bankSync.ts`, `frontend/src/routes/BankTransactions.tsx`,
> `frontend/src/routes/BankRules.tsx` or
> `frontend/src/components/BankRuleForm.tsx`.**
>
> The bank feed is the one place where money enters the books
> without a cashier typing it. A wrong slug, a booking that skips
> the roll-up, or a rule that fires on a closed day silently drifts
> the daily book and the monthly P&L. Every rule below is enforced
> by `tests/Modules/BankSync/` — `test_bank_to_books.py` is the
> end-to-end contract.


## What bank sync is

Stripe Financial Connections pulls a store's bank transactions into
`bank_transaction` (signed `amount_cents`, `description`,
`posted_at`, `stripe_bank_account_id`). The operator — or a rule —
gives each row exactly one **category slug**, and the slug decides
where the money lands in the books.


## The three category families — the slug decides everything

`GET /api/v2/bank/categories` is the ONLY source of the picker.
The SPA never carries its own slug list (it did once, and drifted
from what the server accepted). `bank_category_groups` is what the
server lists and `is_valid_bank_category` is what it accepts, and
the second is now DEFINED as "a slug the first offers" rather than
a parallel list — they cannot drift. The one deliberate extra the
validator takes is the unstripped `bank_charge_0210` beside the
`bank_charge_210` the picker offers.

| Family | Slugs | Effect of tagging |
|---|---|---|
| **Daily book** | every `LINE_ITEM_KINDS` key (`check_deposit`, `cash_expense`, `drop`, …) | Books a `msb_daily_line_item` on a day's book **through the same service path a cashier's entry takes** (`recompute_line_items_total` → `ensure_daily_report`), so the day's rolled-up column moves at once and the report row is created if the day had none. |
| **Monthly P&L** | `BANK_PL_CATEGORIES` (`pl_credit_card_fees`, `pl_money_order_rent`, …, `pl_other_income_3`) | Touches nothing on tag. The monthly P&L sums these rows straight into the mapped `MonthlyFinancial` column (`bank_pl_sums_for_month`). |
| **Other** | `BANK_CATEGORIES_NON_POSTING` + one `bank_charge_<last4>` per connected account | A tag only. The `bank_charge*` family additionally feeds `MonthlyFinancial.bank_charges_total` via prefix match — it predates `pl_*`. |

### The P&L options are the store's, not ours

`BANK_PL_CATEGORIES` maps slug → `MonthlyFinancial` column and
NOTHING ELSE. The operator-facing label lives in
`Monthly.Services.labels`, where the store can change it: a slug is
an identifier and must never move, a label is decoration. Renaming
a line re-labels every option, every tagged row's category and
every rule's target at once, and orphans none of them.

Two rules follow, both enforced in
`tests/Modules/BankSync/test_categories_service.py`:

- **An unclaimed slot is not offered and is not accepted.** The
  five `other_expense_*` and three `other_income_*` columns are
  blank by design; until the store names one on
  `/monthly/categories` it stays out of the picker (a dropdown
  entry called "Other expense 4" is a slug nobody can pick
  meaningfully) and `is_valid_bank_category` refuses it. Naming it
  is what turns it into a category — that is the whole
  add-a-category story.
- **A slug already in use stays offered whatever its name.**
  `_slugs_in_use` reads the store's tagged rows and rule targets,
  so clearing a name later cannot invalidate a rule the store is
  already running.

`taxable_sales` / `non_taxable` are renameable on the P&L but have
NO `pl_*` slug on purpose: the register close already books the
day's sales, and tagging the matching bank deposit into them would
count the same money twice. Do not add one.

`monthly_field_for(slug)` is the single lookup from slug to P&L
column. Daily-book kinds reach the P&L through the daily ledger
(Monthly `_DAILY_DERIVED_FIELDS`), never directly — a
`check_deposit` must not ALSO be summed into a monthly column.


## Booking — the daily-book contract

`categorize_transaction(db, txn, slug, post_to_daily=True,
report_date=None, report_date_explicit=False)` in
`Services/categorize.py` is the only write path for a category,
from the endpoint and from the rule engine alike.

1. **Book through the service, never insert a line directly.** The
   pre-K-1 code inserted the `DailyLineItem` and stopped; the day's
   `checks_deposit` never moved and the operator saw nothing on the
   book. `book_to_daily` calls `recompute_line_items_total`, which
   sums the kind, writes the report column, refreshes over/short and
   creates the report row when missing.
2. **Absolute amounts.** The daily book stores positive numbers; the
   kind says in/out. A −$40.00 debit books as a $40.00 cash expense.
3. **A locked day is refused, and the row is left exactly as it
   was.** The lock is checked BEFORE any write. The service raises
   `DailyBookLockedError(report_date)`; the endpoint turns it into
   `409 {code: "daily_book_locked", report_date}` so the SPA can offer
   "open that day" or "book on another day". The rule engine catches
   it and keeps the tag WITHOUT the line (`locked_skipped`). Nothing
   from the bank feed ever edits a closed day.
4. **The operator chooses the day; the bank only suggests it.**
   `booking_date_for` resolves in one order and there is no other:
   **this call's `report_date` → the row's stored
   `report_date_override` → `posted_at.date()`.** Remote deposits
   post the next morning and weekend deposits post on Monday; both
   belong on the earlier day's close-out.

   The choice is STORED, not just passed. `report_date_explicit`
   is what says a caller is setting it — a date writes
   `txn.report_date_override`, `None` clears it back to the bank's
   date, and a caller that does not pass it leaves an earlier
   choice alone. Without the column, re-tagging a row silently
   walked its line back to the bank's date, which is the same
   class of bug as the un-rolled total above: the operator sees
   nothing and the day drifts. Only `uncategorize_transaction`
   clears the override on its own — the row is back to untouched.

   On the wire the endpoint reads the tri-state off
   `model_fields_set`, so `{"report_date": null}` and an omitted
   `report_date` are different requests. `BankTransactionRow`
   carries both `report_date_override` and `bank_date` so the SPA
   can offer "use the bank's date" without guessing.
5. **Re-categorizing is idempotent.** The old line is removed and
   its day rolled back; the new line is booked and its day rolled
   up. The new line is created BEFORE the old one is deleted so the
   fresh row never reuses the freed id (SQLite reuses max rowid).
6. **Uncategorize unbooks.** Clearing the tag deletes the line and
   rolls the day back. A line the daily book already deleted by
   hand is a no-op — `booked_on` then reads empty.
7. **`post_to_daily=False` is the operator's opt-out**, not the
   default. The SPA books by default; a daily-book slug that is
   tagged but not booked shows "not booked" so it is visible.

`booked_on` / `daily_line_item_id` on `BankTransactionRow` are
derived from the live `msb_daily_line_item` row, not from the FK
alone.


## Rules — the automation contract

`bank_rule` rows are the operator's automation (Monarch-style):
IF conditions THEN category (+ book). `Services/matcher.py`
decides matches; `Services/applier.py` applies them.

- **Conditions AND together.** Description (`DESC_MATCH_TYPES`:
  `contains` / `starts_with` / `ends_with` / `equals` / `regex`,
  case-insensitive), direction (`credit` / `debit`), absolute
  amount range, account. A condition left unset is "any". A rule
  with NO condition is refused on create (422) — it would tag
  everything.
- **First match wins, in `priority` order (asc, id tie-break).**
  The rules page shows exactly this order; `POST /rules/reorder`
  rewrites priorities as 10, 20, 30… and refuses a stale list
  (409) rather than half-applying it. Do not add a second ordering
  key.
- **Operator rules run before built-ins.** `BUILTIN_BANK_RULES`
  (platform-managed, see CLAUDE.md) only fire on rows no operator
  rule matched, and NEVER book a line.
- **A rule never overrides a hand-set tag.** Every apply path
  (`apply_rules_to_uncategorized_row`, `apply_rule_to_existing`)
  only touches rows with an empty `category_slug`.
- **A rule shifts the booked day, it cannot name one.**
  `post_date_offset_days` (−31…31, 0 = the bank's date) is added to
  the bank's date by `rule_booking_date` in `applier.py`. A rule
  fires on rows nobody has looked at yet, so an absolute day would
  be meaningless — the absolute day belongs on the transaction. A
  non-zero offset is applied `report_date_explicit`, so the row
  remembers the day even when the booking is skipped for a locked
  day. The offset only decides WHICH day a line lands on, never
  whether one is written: `auto_post` still governs that. A
  calendar-day shift cannot tell a Saturday deposit from a Sunday
  one inside a Monday posting; that case stays the per-transaction
  override.
- **Booking on match** requires BOTH `rule.auto_post` AND the
  caller's `allow_auto_post`: on for freshly-synced rows and for an
  explicit apply; off for the historical backfill during a sync,
  where the daily book may already be reconciled.
- **Apply to existing is explicit.** `POST /rules` with
  `apply_to_existing` and `POST /rules/{id}/apply` return
  `{tagged, booked, locked_skipped}`; the SPA shows the counts. A
  rule saved without it affects only future syncs.
- **The SPA's "Make a rule" prefill** (`lib/bankRuleSuggest.ts`)
  strips digits, dates and reference numbers from the description
  so the suggested `contains` text fires on the next statement, and
  takes the direction from the amount's sign.
- **Match-type names are shared.** The request schema's pattern,
  `DESC_MATCH_TYPES` and the SPA's `MATCH_TYPE_OPTIONS` must agree.
  The SPA once sent `exact` for a backend that only knew `equals`.


## Audit

Every mutating endpoint writes an operator-audit row through
`_audit_bank_action`: categorize / uncategorize
(`target_type="bank_transaction"`), rule create / update / toggle /
delete / apply / reorder (`bank_rule`), connect / disconnect /
refresh / sync / rename (`bank_account`). Amounts stay out of the
summary; the slug and whether a line was booked go in.


## Cross-module dependencies

- **DailyBook** — booking uses `recompute_line_items_total` and
  respects `locked_at`. If the lock semantics or `LINE_ITEM_KINDS`
  change, the booking path changes with them. See
  `DailyBook/INVARIANTS.md` → "Cross-module dependencies".
- **Monthly** — `bank_pl_sums_for_month` is the feed;
  `Monthly/INVARIANTS.md` → "Category 3" owns the conditional-lock
  rule (bank sum wins when > 0, else the typed value). Adding a
  `pl_*` slug = one `BANK_PL_CATEGORIES` row whose column is in
  `EDITABLE_MONTHLY_FIELDS` + `INCOME_FIELDS` / `EXPENSE_FIELDS`
  AND in `MONTHLY_LINE_DEFAULTS` (the picker renders the store's
  name for the column, so a column with no default name has no
  label to fall back to).
  `Monthly.Services.labels` owns every operator-facing P&L name;
  this module imports it and never keeps its own copy.
- **Batches** — the `mt_ach_*` tags are what the ACH module
  reconciles against; they never post.


## Test surface

```bash
pytest tests/Modules/BankSync/ tests/Modules/Monthly/ tests/test_monthly_locked_fields.py -q
cd frontend && npx vitest run src/lib/bankRules.test.ts src/lib/bankRuleSuggest.test.ts
```

`test_bank_to_books.py` covers the booking roll-up, the locked-day
refusal at both layers, `report_date`, uncategorize, the categories
endpoint, the 422 on unknown slugs, `booked_on`, apply-to-existing,
`/apply`, `/reorder` and the monthly feed.
`test_posting_date.py` covers the booking-day rules specifically:
the resolution order, the override surviving a re-tag, the explicit
clear, the untouched row after a locked-day refusal, and the rule's
day shift including the locked case. If one of those fails you have
changed a contract above — update the test AND this file.

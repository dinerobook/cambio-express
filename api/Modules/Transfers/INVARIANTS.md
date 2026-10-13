# Transfers — Invariants

> **Read this before editing anything in `api/Modules/Transfers/`,
> `api/Modules/Customers/Services/customers.py` (the upsert path),
> `frontend/src/routes/NewTransfer.tsx`, or
> `frontend/src/routes/EditTransfer.tsx`.**
>
> The Transfer is the core revenue-bearing entity. Every fee dollar
> the store earns, every federal-tax dollar that leaves with the
> ACH withdrawal, flows through this module. A subtle bug here
> compounds: it shows up in the next ACH batch, in the monthly
> P&L, in the cashier productivity report, and in the customer's
> receipt. By the time anyone notices, the books have already
> been closed on the wrong numbers.
>
> Every rule below is enforced by tests in
> `tests/Modules/Transfers/`. Breaking one of these invariants
> will break a test. If you find yourself needing to break a rule,
> the change deserves its own design discussion + a separate PR.


## What a transfer is

One row in `msb_transfer` per money-movement event a cashier logs:
remittance (send money to family abroad), bill payment, top up,
recharge, or payout (the store pays cash to a recipient — see
"Payouts"). The Transfer carries:

- the customer who sent it (linked to `Customer` for autofill on
  return visits; mirrored into `sender_*` columns on this row so
  the receipt prints correctly even after the Customer row is
  edited or deleted),
- the recipient details,
- the **money math** (`send_amount`, `fee`, `federal_tax`,
  `commission`),
- the **status** (Sent / Cancelled / etc.),
- the cashier who entered it (`created_by` for the login user +
  `employee_id` / `employee_name` for the "Processed by"
  attribution, which is the source of truth for
  cashier-productivity reports + payroll commission splits),
- the company (Intermex / Maxi / Barri / etc.).

Transfers are read-mostly: the typical cashier creates one,
maybe edits it once if a typo, rarely deletes. ACH batches +
monthly P&L sum across them; cancellation flips the status
without deleting the row (the audit trail needs it).


## Money math — the four-field invariant

Every transfer has four money fields:

| Field | Source | Who collects it |
|---|---|---|
| `send_amount` | Cashier enters | Goes to the recipient (via ACH) |
| `fee` | Cashier enters | **Store revenue** |
| `federal_tax` | **Server-computed** (see below) | Leaves with ACH; remitted to IRS |
| `commission` | Cashier enters (optional) | Internal — store's commission from the company |

**The bedrock formula** (`Transfer.total_collected`):

```
total_collected = send_amount + fee + federal_tax
```

That's what the customer hands over at the counter. It includes
the tax (which leaves) but NOT the commission (which is internal
accounting between the store and the wire company; the customer
doesn't pay it).

Reports that aggregate transfers (Sales by Company, Sales by
Employee, ACH Volume, etc.) follow the same formula. **Do not
change it.** Page-total sums in `list_transfers` use the same
expression — keep them in sync.

**Storage is INTEGER CENTS (P0-3).** The four money fields live in
`send_amount_cents / fee_cents / federal_tax_cents /
commission_cents` (BigInteger); the dollar-named attributes are
`@property` get/set pairs converting through `api/Core/Money.py`
(HALF-UP at the cent). The rules that follow from this:

- Python code (Services, Controllers, ORM kwargs) keeps reading
  and writing **dollars** through the properties — don't convert
  by hand at call sites.
- SQL expressions (`func.sum`, filters, `order_by`, sort maps)
  MUST use the `_cents` columns — the dollar names are plain
  properties and fail loudly in a query. Convert back to dollars
  with a single `/ 100.0` around the whole aggregate expression
  (one division stays exact; don't divide per-term).
- Exact math belongs in cents: use `total_collected_cents` (and
  `ACHBatch.transfers_total_cents` / `variance_cents`) for any
  comparison or reconciliation; the dollar twins are display
  views. The same pattern applies to `ACHBatch.ach_amount_cents`.

## Debit card sends

`payment_method` says how the customer paid: `"cash"` or
`"debit_card"` (on the company's card terminal: no cash reached the
drawer; the company credits it on the statement invoice). NULL on
every row saved before the column existed, and **NULL reads as cash**
everywhere (`Transfer.is_debit_card`, the `paid_by` list filter, the
API's `payment_method` field, the `paid_by` audit label).

- The money math is unchanged: a debit card send has the same
  `send_amount + fee + federal_tax`, the same tax, and counts in every
  volume report like a cash send. Only the cash it brings in differs.
- The daily book is where it matters: its Services box takes the
  company's debit card total OFF the company's cash (DailyBook
  INVARIANTS "Debit card and payouts"). The transfer log's auto
  figure for it is Σ `total_collected` of the day's debit card sends.
- ACH batches: the company invoices a debit card send like any send
  on the batch it is linked to (`transfers_total` is unchanged), and
  credits what the customer paid on the card (`send_amount + fee +
  federal_tax`) on its NEXT invoice: the same company's next batch by
  `(ach_date, id)`. That batch expects `transfers_total -
  card_credit`, and its variance is measured against that
  (`Batches/Services/batches.py::card_credits_for_store`; the model's
  `ACHBatch.variance_cents` agrees). Until the company has a later
  batch the credit shows as pending on the batch it came from.
  `tests/Modules/Batches/test_batch_card_credits.py` pins this.

## Payouts

A payout is `service_type = "Payout"` (`PAYOUT_SERVICE` in
`Models/__init__.py`): the store hands cash to a recipient for the
company. Rules, enforced in `Services/transfers.py::
check_payment_rules` on create AND update (422):

- Always cash: `payment_method = "debit_card"` is refused.
- No fee: `fee > 0` is refused (the recipient is paid the full
  amount). Commission is allowed.
- No federal tax: `"Payout"` is in `TAX_EXEMPT_SERVICES` (money comes
  in from abroad; nothing is sent).
- Parties: the `sender_*` fields hold the customer **paid at the
  counter** (the person the store identifies and pays, so the
  customer directory upsert runs on them as usual) and the
  `recipient_*` fields hold who sent the money. The SPA relabels both
  blocks (`lib/transferKinds.ts::transferWording`); the receipt does
  too.
- **A payout is never volume.** Every sum of "money sent" filters on
  `Transfer.is_send` (a hybrid: `service_type != "Payout"`): the
  report `period_filters`, the dashboards, the owner and superadmin
  rollups, the daily summary email, the tax pack's per-customer
  totals, recent recipients, ACH batch totals / counts and the list's
  `page_amount`. The employee dashboard gives them their own
  `totals.paid_out`. When you add a new volume query, add
  `Transfer.is_send` next to the status filter.
- `total_collected` keeps its formula; on a payout it equals the
  amount paid out (fee and tax are 0). The SPA shows it as cash out.
- The daily book takes the company's payouts OFF its cash (DailyBook
  INVARIANTS "Debit card and payouts"); the transfer log's auto figure
  is Σ `send_amount` of the day's payouts, and a payout never counts
  in that company's amount / fees / tax.

## Federal tax — server-computed, never client-supplied

`federal_tax` is the single most-corrupted field in this system
if you let the client send it. The rule:

> `federal_tax` is **always** recomputed server-side from
> `(send_amount, service_type, country, store)` via
> `federal_tax_for()` in `api/Modules/Transfers/Services/tax.py`.

The create + edit endpoints intentionally drop any `federal_tax`
the client sends. The Pydantic schema (`CreateTransferRequest`)
doesn't even list `federal_tax` as a field — `extra="forbid"`
makes sending it a 422.

`federal_tax_for()` returns 0.0 in three cases:

1. `service_type` is in `TAX_EXEMPT_SERVICES` (Bill Payment,
   Top Up, Recharge — no ACH withdrawal crosses a border; Payout —
   money comes in, nothing is sent).
2. Recipient `country` is in `DOMESTIC_COUNTRIES` (today: just
   "United States" — the federal tax is the IRS levy on money
   sent abroad).
3. The store has no `federal_tax_rate` set (defensive — defaults
   to 0.01 = 1% in seed data).

Otherwise: `round(send_amount * store.federal_tax_rate, 2)`.

**Anti-drift rules:**

- Don't let "edit transfer" preserve a federal_tax from the
  before-state. Always recompute — the tax rate could have
  changed at the store level, or the cashier could have changed
  the country/service_type.
- Don't move the tax computation into `before_insert` /
  `before_update` SQLAlchemy hooks. The Service layer being the
  single chokepoint is the invariant — hooks add a parallel
  write path that's easy to forget about in tests.
- Don't try to "optimize" by skipping the recompute when
  fields appear unchanged. The recompute is cheap; the bug
  surface of conditional skipping is not.

## Service-type vocabulary

The complete set of valid `service_type` values lives in
`api/Modules/Transfers/Services/tax.py::SERVICE_TYPES`:

- `"Money Transfer"` — the historical default + the only tax-
  carrying service
- `"Bill Payment"` — tax-exempt
- `"Top Up"` — tax-exempt
- `"Recharge"` — tax-exempt
- `"Payout"` — tax-exempt, cash OUT (see "Payouts")

The transfer form's dropdown options MUST match this tuple
exactly (they live in `frontend/src/lib/transferKinds.ts`, shared by
the new and edit forms and the list filter). `normalize_service_type()` coerces unknown values to
`"Money Transfer"` (the historical default) rather than failing
loudly — this is intentional so a malformed payload can't
accidentally disable tax. Adding a new service type means:

1. Append to `SERVICE_TYPES`
2. Decide whether it's tax-exempt; if so add to
   `TAX_EXEMPT_SERVICES`
3. Update `SERVICES` in `frontend/src/lib/transferKinds.ts` (both
   forms read it)
4. Add a test variant in `tests/Modules/Transfers/test_tax_service.py`


## Customer upsert — owner-umbrella scope

The transfer form's "sender" block triggers a
`Customers.Services.upsert()` call on every save. The Customer
row is the source of truth for the autofill suggestions on
return visits, the cross-store directory, and the recent-
recipients hints.

**Lookup priority** (canonical contract in `customers.py`
docstring + `upsert()` body):

1. **Explicit `customer_id`** — the SPA passes this when the
   sender autocomplete picks an existing row. We accept the id
   ONLY if the target customer lives in the **owner umbrella**
   (`sibling_store_ids(db, store_id)`), never beyond. A cashier
   at one owner's store can't accidentally re-link a transfer
   to a customer from a different owner's store.
2. **`(phone_country, phone_number)` across the umbrella** —
   when the sender's phone matches an existing customer at ANY
   store in the owner umbrella, we reuse that customer row. A
   sender who's been to Store A and now shows up at Store B
   (same owner) gets one customer record, not two.
3. **Otherwise create new** — a fresh `Customer` row pinned to
   the current `store_id` (the "home store"). Later transfers
   at sibling stores point `customer_id` at this row; they don't
   create a duplicate. A sender with **no phone** always takes
   this step (an empty phone is not a lookup key) and the row is
   stored with `phone_number` **NULL**, never `""`: the
   `(store_id, phone_country, phone_number)` unique constraint
   treats NULLs as distinct, so a store can log any number of
   phone-less senders. With `""` only the first one fit and every
   later phone-less transfer failed with a 500. Read sites render
   NULL as `""`.

The home store of a Customer **never moves**. A customer first
seen at Store A stays pinned to Store A in the `customer.
store_id` column even when they show up at Store B (same
owner). Sibling stores just reference the existing row by id.

**Last write wins** on every non-empty field. If a customer
visits Store B and the cashier updates their address, the
shared Customer row is updated — Store A sees the new address
next time too.

**Anti-drift rules:**

- `sibling_store_ids()` is the SINGLE chokepoint that defines
  the owner umbrella scope. Don't add new "is this customer
  visible to this store?" predicates elsewhere — extend that
  function instead.
- Unrelated stores (no shared owner) stay isolated. The phone
  match in step 2 ranges over the umbrella, NOT over every
  store in the platform.
- The `customer_id` passed in step 1 isn't trusted. We re-look-
  up by id with `find_by_id_in_stores(siblings)` so a forged
  payload can't link to a stranger's row.

## Status state machine

`Transfer.status` is a free-form string column today (legacy)
but only a handful of values are in active use:

- `"Sent"` — default, the happy path. Counts toward all
  reports, batch totals, monthly P&L.
- `"Cancelled"` — the transfer was reversed before settlement.
  The row stays for audit; reports filter it out via
  `status != "Cancelled"`.
- `"Pending"` — rarely used today. Reports treat as `"Sent"`.

**No deletion on cancel.** A cancelled transfer keeps the row so
the audit history survives. Hard-delete is a separate action via
`DELETE /api/v2/transfers/{id}` (admin-only; cascades the
`TransferAudit` rows).

## Audit invariants

Every mutation writes a `TransferAudit` row via
`Services/audit.py::record_audit`:

- `create_transfer` → action `"created"`, summary `"Logged by
  {employee_name}."`
- `update_transfer` → action `"updated"` OR `"status_changed"`
  (the latter when ONLY the status field changed; the admin UI
  highlights these), summary built from `summarize_changes`
  (before/after diff capped at 4 fields + "+N more" overflow).
- `delete_transfer` → no `TransferAudit` row (the cascade
  deletes the existing audit rows — operator's audit log gets
  its own entry via `OperatorAuditLog`).

The `TRANSFER_AUDIT_FIELDS` list defines which Transfer columns
get audited. Adding a column to that list adds it to the diff
summary; removing one silently stops auditing it (bad).
Internal columns (commission, internal_notes) are intentionally
NOT in the audit list — operator-only context, not legally-
relevant.

**Don't bypass the audit.** Every controller that mutates a
Transfer must call `record_audit`. Search for `record_audit` in
the Transfers Controllers if adding a new mutation route.

## Employee attribution ("Processed by")

Every transfer carries both:

- `created_by` — the **login user** who saved the row. Used
  for "who pressed Save", not for productivity metrics.
- `employee_id` + `employee_name` — the **named-employee
  roster pick** the cashier made in the "Processed by"
  dropdown. This is the source of truth for cashier-
  productivity reports + payroll commission splits.

These are SEPARATE concepts on purpose:
- A store manager can save transfers on behalf of a cashier who
  forgot to log one — `created_by` reflects the manager, but
  `employee_name` is the cashier who actually took the cash.
- The `employee_name` is **snapshotted** at save-time. If the
  StoreEmployee is later renamed, deactivated, or deleted, the
  transfer still shows the original name. Reports group by the
  name string, not by the FK, for this reason.

`pick_employee()` in `Services/form_inputs.py` is the only
helper that should resolve a roster id → `(StoreEmployee,
str)` pair. The create + edit endpoints require it to return a
non-None employee — anonymous transfers aren't allowed.

The edit form preselects the stored employee. One who has since
been deactivated stays selectable as "(former)", so editing an old
transfer never moves its attribution.

## Edits replace the whole row

`PUT /transfers/{id}` has no PATCH semantics: every field in
`CreateTransferRequest` is written, and an omitted field is written
as its default. So `GET /transfers/{id}` returns `TransferDetail`
(the list row plus every field the PUT writes), and
`EditTransfer.tsx` hydrates from it and sends back the fields it
has no input for (commission, status notes, internal notes).
When you add a field to `CreateTransferRequest`, add it to
`TransferDetail` and `_to_detail` too, or every edit will blank it.
`test_get_detail_round_trips_every_edit_field` pins this.

## Create saves once per form (`Idempotency-Key`)

`POST /transfers` takes an optional `Idempotency-Key` header (max
64 chars). `NewTransfer.tsx` makes one key when the form opens
(`newIdempotencyKey()`) and sends it on every save attempt. The key
is stored on the row as `client_request_id`, unique per store
(`ux_msb_transfer_store_client_request_id`). A create whose key the
store already holds returns that transfer unchanged: no second row,
no second customer upsert, no second audit line, and the new body is
ignored (changes go through Edit). Two saves racing on one key: the
index lets one INSERT through and the Controller answers the other
with the winner. A request without a key (or a blank one) saves
every time, exactly as before. The key never widens access: the
`transfers.create` check runs before the lookup.

Why: a live store's employee got a 500 on a save that had already
committed, pressed Save 8 times and logged 8 transfers. The 500
itself came from the rate limiter stamping headers after the route
returned (`api/Core/RateLimit.py` keeps `headers_enabled=False`),
but any lost response (dropped Wi-Fi, a timeout) leaves the cashier
in the same spot, so the form must be safe to resubmit.
`tests/Modules/Transfers/test_transfer_create_retry.py` pins this.

## Cross-module dependencies

- **Batches** (`api/Modules/Batches/`): aggregates transfers
  into ACH batches. `ACHBatch.transfers_total = Σ (send_amount
  + federal_tax)` (NOT plus fee — fee is store revenue and
  doesn't ride the ACH). Breaking the fee-vs-tax split here
  silently corrupts batch totals. Debit card sends are credited back
  on the company's next batch ("Debit card sends" above).
- **Monthly P&L** (`api/Modules/Monthly/`): sums transfer
  `(send_amount + fee + federal_tax)` into the monthly receipt
  line. Reads from `msb_transfer` directly + the per-(store, date,
  company) `msb_mt_summary` table (see below).
- **DailyBook** (`api/Modules/DailyBook/`): the per-store /
  per-date `msb_mt_summary` table is the per-company roll-up the
  daily book reads. **Not auto-recomputed from `msb_transfer` rows**
  — the cashier updates it manually via the MT-breakdown editor
  on the daily-book page (`PUT /daily/{store}/{date}/mt-
  breakdown`). The auto-fill defaults shown in that editor DO
  come from `summarize_transfers_for_day` reading `msb_transfer`
  rows, but applying them is an explicit action.
- **Customers** (`api/Modules/Customers/`): every transfer save
  upserts a customer (see above). Customer merge / delete
  reassigns transfers via `customer_id`.
- **ReturnChecks** (`api/Modules/ReturnChecks/`): independent
  of transfers, but receipts can reference both.

**Net rule**: a Transfer write should not directly mutate
`msb_mt_summary`, `msb_ach_batch`, `msb_monthly_financial`, or any other
roll-up table. Those tables either re-derive on demand
(monthly P&L) or have their own write paths (batches, MT
breakdown). Adding a fan-out from Transfer-write to a roll-up
table is the kind of change that creates phantom drift bugs.

## Indexes

The Transfer model defines six indexes (see model file). All
are load-bearing on hot-path queries:

- `ix_transfer_store_send_date` — every period filter on every
  Reports aggregator.
- `ix_transfer_customer_id` — umbrella-customer + new-vs-
  returning lookup.
- `ix_transfer_created_by` — sales-by-employee + employee-
  activity reports.
- `ix_transfer_status` — active-vs-cancelled filter on every
  list view.
- `ix_transfer_confirm_number` — transfers-list "look up by
  confirmation #" search.
- `ux_msb_transfer_store_client_request_id` (UNIQUE) — the
  save-once key above. Correctness, not speed: dropping it lets
  two racing saves both land.

**Don't drop these.** If you're tempted to remove one, run the
matching report at scale first (`pytest tests/test_transfer_
indexes.py` covers the EXPLAIN plans).

## Company + country pick-lists come from Settings

The transfer form's **Company** and **Country** pickers are the
store's own lists, both managed under Settings → General, read by
`GET /transfers/choices` (`form_choices`):

- **Companies** = `store_mt_companies(store)`, the ACTIVE money
  transfer company roster. The MSB daily book breaks down by the
  very same list, so a company added or switched off in Settings
  reaches both at once. Never hard-code companies in the SPA again
  (that was the 2026-10-13 bug: the form had its own list of ten).
  The ACH batch form picks from the same list.
- **Countries** = `store_transfer_countries(store)` over the
  nullable `tenancy_store.transfer_countries` CSV. NULL = the
  built-in `TRANSFER_COUNTRIES` the form always showed, so no store
  sees a change until its admin edits the list.
- The lists only drive the pickers. The server does not refuse a
  company or country that is off the list, because a saved transfer
  keeps what it was saved with: an edit offers the saved value after
  the store's list (`choicesWith`) and sends it back unchanged.
  Removing one in Settings never rewrites history. The federal-tax
  rule still keys on the country NAME (`DOMESTIC_COUNTRIES`).
- `Transfer.company` is `String(30)`, so a NEW roster name is capped
  at 30 characters (`MAX_TRANSFER_COMPANY_NAME_LEN`); a longer name
  a store already had stays savable.
- `GET /transfers/choices` opens with `transfers.read` OR
  `batches.read` (both forms need it) and needs a store scope.

## What's safe to change

- Adding a new optional column to `Transfer` (with a migration,
  with a sensible default, and not in the audit list unless
  the column is operator-visible).
- Adding a new tax-exempt service type (one entry in
  `SERVICE_TYPES` + `TAX_EXEMPT_SERVICES` + the frontend
  dropdown + a test).
- Adding a new audit field (one tuple in
  `TRANSFER_AUDIT_FIELDS` — the diff helper picks it up
  automatically).
- Reports that read from `Transfer` (no schema change needed,
  just a new SELECT).

What needs a design discussion FIRST:

- Changing the `total_collected` formula.
- Changing where `federal_tax` is computed (e.g. moving it to
  a Pydantic validator, a SQLAlchemy event hook, etc.).
- Adding cross-field validation that depends on multiple
  transfers (e.g. "no more than N transfers per customer per
  day") — these tend to have edge cases nobody catches in code
  review.
- Auto-computing or auto-touching any roll-up table (msb_mt_summary,
  msb_ach_batch, msb_monthly_financial) from the Transfer write path.
- Changing `sibling_store_ids` or the upsert lookup order.
- Renaming `service_type` values or dropping one (historical
  rows still reference them).

## Test surface

`tests/Modules/Transfers/` covers:

- `test_transfer_choices.py` — the company + country lists: the
  endpoint (grant, deny, revoke, store scope), the Settings write
  for countries, the company-name cap, and that a saved transfer
  keeps a company / country that left the lists.
- `test_debit_card_and_payouts.py` — payment method + payout rules
  on create / update (grant, deny, 422s, audit), the list filters,
  `page_amount`, the receipt, batch totals and the employee
  dashboard totals.
- `test_payment_method_migration.py` — the additive migration.

- `test_tax_service.py` — `federal_tax_for` across every
  (service_type, country, store) combination.
- `test_transfers_services.py` — `create_transfer`,
  `update_transfer`, `delete_transfer` — including the
  server-recompute of federal_tax + the audit row.
- `test_transfers_controllers.py` — every POST / GET / PUT /
  DELETE route, including the `extra="forbid"` 422 on a
  client-supplied `federal_tax`.
- `test_transfers_repository.py` — filter + pagination
  contracts.
- `test_audit_service.py` — `TRANSFER_AUDIT_FIELDS` + diff
  helper.
- `test_companies_service.py` — store-configured MT companies.
- `test_form_inputs_service.py` — `pick_employee` +
  `parse_dob`.
- `test_get_by_id_endpoint.py` / `test_receipt_endpoint.py` —
  single-row + receipt-render routes.
- `tests/Modules/Customers/test_upsert_service.py` — the
  three-step lookup chain across the owner umbrella.
- `tests/test_transfer_indexes.py` — index presence + EXPLAIN
  plans for the hot-path queries.

Before changing this module, run:

```bash
pytest tests/Modules/Transfers/ tests/Modules/Customers/test_upsert_service.py
```

If any test fails, you've broken an invariant. Either:
1. Your change is wrong — fix it.
2. The invariant has genuinely changed — update the test AND
   this document AND open a PR that's explicit about the
   contract change.

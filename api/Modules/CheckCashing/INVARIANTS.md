# Check cashing — invariants

## Opt-in and standalone

- Every route answers **403 "Check cashing is not turned on for this
  store."** until the store's `check_desk` flag is on. The flag is
  declared OFF in `DEFAULT_FEATURE_FLAGS` and resolved with
  `opt_in_flag_enabled` (never fails open). It reaches the SPA through
  `features` on `/auth/session-status` (`OPT_IN_NAV_FLAG_KEYS` in
  `api/Modules/Billing/Services/feature_flags.py`); a person's
  `module_access` list does not hide it.
- Nothing outside this module reads these tables, and this module
  writes nothing outside them except operator-audit rows.

## Rights

| Right | Who by default | Allows |
|---|---|---|
| `check_cashing.read` | Admin, employee, owner | Lists, profiles, settings (read) |
| `check_cashing.create` | Admin, employee | Add a customer or company |
| `check_cashing.update` | Admin, employee | Edit a profile, add / edit / remove an ID |
| `check_cashing_manage.update` | Admin | Settings; block or trust; an own fee on a customer or company |

- `check_cashing` has no `delete` (a check will be voided, never
  deleted; merge comes later). Both resources are in
  `LATER_RESOURCES` so existing databases get their defaults once.
- The manage switch is checked only when a value it owns **changes**:
  a cashier saving a blocked customer's new phone number, status and fee
  untouched, needs no manage right.
- The view-only Accountant is refused (not on its route list).

## Data

- Money is integer cents. A fee is `fee_kind` + `fee_value`: `percent`
  stores basis points (1% = 100), `flat` stores cents; NULL kind = no
  own fee. The API speaks percent and dollars (value × 100 stored).
- Fee order (applied from PR 2, Cash a check): the customer's own fee,
  else the company's, else the store default from settings; plus the
  optional base charge (checks under `base_charge_under` pay at least
  `base_charge`). Settings without a saved row read `DEFAULT_SETTINGS`.
- A customer is created with at least one ID (max 10) and can never
  remove the last one (409): no check is cashed without an ID on file
  (owner, 2026-11-07). An expired ID only warns by default;
  `expired_id_mode = "block"` makes it block (enforced from PR 2).
- A company's routing number passes the ABA check digit
  (`aba_routing_valid`); routing + account are entered together or not
  at all, and are unique within the owner umbrella (409 naming the
  company that holds them).
- Status is `normal` / `trusted` / `blocked`; going back to `normal`
  clears the reason.

## Scope

- Customers and companies are pinned to the store that added them and
  shared across its owner umbrella (`sibling_store_ids`), like the
  Transfers customer list. Every read and write checks the row's store
  is in the caller's umbrella (404 otherwise). Each sibling store still
  needs its own `check_desk` switch.
- All four tables are in the retention purge (`STORE_OWNED_MODELS`),
  customer IDs before customers.

## Audit

Every change writes an operator-audit row: `create_check_customer`,
`update_check_customer`, `block_check_customer`, `trust_check_customer`,
`unblock_check_customer`, `add_check_customer_id`,
`update_check_customer_id`, `delete_check_customer_id`,
`create_check_company`, `update_check_company`, `block_check_company`,
`trust_check_company`, `unblock_check_company`,
`update_check_cashing_settings`. ID numbers in summaries are masked.

Tests: `tests/Modules/CheckCashing/`.

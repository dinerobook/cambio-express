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
| `check_cashing.create` | Admin, employee | Add a customer or company; cash a check or save it as not accepted |
| `check_cashing.update` | Admin, employee | Edit a profile, add / edit / remove an ID |
| `check_cashing_manage.update` | Admin | Settings; block or trust; an own fee on a customer or company; approve a check that needs a manager; void a check |

- `check_cashing` has no `delete` (a check is voided, never deleted;
  merge comes later). Both resources are in
  `LATER_RESOURCES` so existing databases get their defaults once.
- The manage switch is checked only when a value it owns **changes**:
  a cashier saving a blocked customer's new phone number, status and fee
  untouched, needs no manage right.
- The view-only Accountant is refused (not on its route list).

## Data

- Money is integer cents. A fee is `fee_kind` + `fee_value`: `percent`
  stores basis points (1% = 100), `flat` stores cents; NULL kind = no
  own fee. The API speaks percent and dollars (value × 100 stored).
- Fee order (`work_out_fee`): the customer's own fee, else the
  company's, else the store default from settings; then the optional
  base charge (checks under `base_charge_under` pay at least
  `base_charge`); never more than the check. A percent rounds half up
  to the cent. Settings without a saved row read `DEFAULT_SETTINGS`.
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
- Every table is in the retention purge (`STORE_OWNED_MODELS`): cashed
  checks first, then customer IDs, customers, companies. Before a
  store is purged, a customer or company it added that a sibling store
  cashed checks for moves to that store, IDs and all
  (`rehome_shared_parties`), and pointers at the doomed store's logins
  on a sibling's checks are cleared, so a sibling's records survive.

## Cash a check

One `msb_cashed_check` row per check brought to the counter, status
`cashed`, `declined` (not accepted, with a reason) or `voided`.
`Services/cashing.py` is the only writer.

- **The review** (`review()`) is worked out live from what is typed
  and never saved by itself (`POST /checks/review` changes nothing).
  Each item has a level:

  | Level | Meaning | Codes |
  |---|---|---|
  | `block` | cannot be cashed until fixed | `customer_blocked`, `company_blocked`, `no_id`, `id_expired` when `expired_id_mode = "block"` |
  | `approve` | a manager (`check_cashing_manage.update`) ticks it | `duplicate` (same company + check number already cashed in the umbrella), `daily_limit` (today's cashed total + this check over the store's `daily_limit_cents`) |
  | `warn` | the cashier ticks that they checked it | `cashed_today`, `id_expired` (default mode, every ID expired), `future_dated`, `stale_dated` (over 180 days) |
  | `info` | shown only | `customer_trusted`, `company_trusted`, `first_check`, `ctr_due` (today's cash + this check over $10,000; filing a CTR is backlog) |

  The SPA lists them worst first. "Today" is the store's day
  (`store_local_today`); totals count `cashed` checks across the owner
  umbrella, so a customer cannot split a limit across sibling stores.
- **Cashing** (`record()`) runs the review again on the server and
  refuses (409) while any block is left or any `warn`/`approve` code is
  not in `acknowledged`; an `approve` code from someone without the
  manage right is 403. The fee charged may differ from the suggested
  one (both are saved, the audit summary shows both) but never exceeds
  the check. `cash_cents = amount − fee`. The ticked codes are saved
  in `warnings`, the approving manager in `approved_by`.
- **Not accepted** is always saved, with its reason, even for a
  blocked customer: it is the history the next cashier sees.
- **Void**: manager only, at the store that cashed it, on the same
  store day (later it is a bad check, PR 5); with a reason. A voided
  or declined check never counts towards today's total or the stats.
- **Stats** on a profile: this store, plus "all your stores" when the
  umbrella has more than one; the latest 15 checks of every status. A
  cross-DineroBook network count needs the owner's go-ahead first.

## One computer

Check cashing works on ONE activated computer per store (owner,
2026-11-09: "if anyone can login anywhere then check cashing will be
misused"). A password alone never opens it.

- **The key** is a random token in an httpOnly, `SameSite=Strict`
  cookie `db_check_device_<store_id>`, path `/api/v2/check-cashing`
  (5 years; `Secure` in production). Only its sha256 is stored, in
  `msb_check_device` (`Services/device.py` is the only writer). One
  cookie per store, so one computer can serve several owner stores,
  each activated on its own.
- **The gate** is `require_check_device` on every check cashing router
  except the device routes: without the store's live key, 403 "This
  computer is not activated for check cashing." or "Check cashing is
  locked to <name>. An Admin can move it to this computer." It runs
  after the module switch (module off keeps its own 403) and refreshes
  `last_seen_at` every 10 minutes. The superadmin is exempt (support).
  The back office never checks the key.
- **Device routes**: `GET /device` (any check cashing right: is this
  the computer?), `POST /device/activate` and
  `POST /device/switch-off` (`check_cashing_manage.update` only).
  Activating revokes the old computer at once (its key opens nothing
  any more); the SPA asks in a popup before moving. Switching off
  with nothing active is 409.
- **Desktop only**: activation refuses a phone or tablet browser (409,
  by User-Agent); the SPA refuses windows under 1024 px. The cookie is
  the lock; the screen size check is convenience.
- Revoked rows are kept (history); devices purge with the store.

## Audit

Every change writes an operator-audit row: `create_check_customer`,
`update_check_customer`, `block_check_customer`, `trust_check_customer`,
`unblock_check_customer`, `add_check_customer_id`,
`update_check_customer_id`, `delete_check_customer_id`,
`create_check_company`, `update_check_company`, `block_check_company`,
`trust_check_company`, `unblock_check_company`,
`update_check_cashing_settings`, `cash_check`, `decline_check`,
`void_check`, `activate_check_device` (summary names the computer it
replaces), `switch_off_check_device`. ID numbers in summaries are masked.

Tests: `tests/Modules/CheckCashing/`.

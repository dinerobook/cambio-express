# CheckCashing — read before editing

Loaded automatically when Claude reads a file in this module. The rules
are in `INVARIANTS.md`, imported below. Plan the owner approved on
2026-11-09: https://claude.ai/artifact/E6PUWxZy3fefeoboJoTi9q (six PRs:
foundation, Cash a check, images, the Excella helper, bad checks and
reports, the cloud picture add-on).

SPA files that count as CheckCashing files:
`frontend/src/api/checkCashing.ts`, `frontend/src/routes/CheckCustomers.tsx`,
`frontend/src/routes/CheckCustomerForm.tsx`,
`frontend/src/routes/CheckCompanies.tsx`,
`frontend/src/routes/CheckCompanyForm.tsx`,
`frontend/src/routes/CheckCashingSettings.tsx`.

- **Standalone (owner, 2026-11-07).** This module must not read or
  write the daily book, the monthly P&L, Returned checks or the
  Transfers `Customer` table, and no other module may read its tables.
  Connecting it is a later, separate decision of the owner.
- **Two switches, not one.** `check_desk` (opt-in, off) shows this
  module; the older `module_check_cashing` (on for every store) is the
  Returned checks pages and the daily-book fee boxes. Never merge them.

@INVARIANTS.md

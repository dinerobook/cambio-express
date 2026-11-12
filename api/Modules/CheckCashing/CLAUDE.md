# CheckCashing — read before editing

Loaded automatically when Claude reads a file in this module. The rules
are in `INVARIANTS.md`, imported below. Plan the owner approved on
2026-11-09: https://claude.ai/artifact/E6PUWxZy3fefeoboJoTi9q (six PRs:
foundation, Cash a check, images, the Excella helper, bad checks and
reports, the cloud picture add-on). PR 5 is split: bad checks first,
then the checks list, daily summary and view-only reports.

SPA files that count as CheckCashing files:
`frontend/src/api/checkCashing.ts`, `frontend/src/routes/CheckCustomers.tsx`,
`frontend/src/routes/CheckCustomerForm.tsx`,
`frontend/src/routes/CheckCompanies.tsx`,
`frontend/src/routes/CheckCompanyForm.tsx`,
`frontend/src/routes/CheckCashingSettings.tsx`,
`frontend/src/routes/CashCheck.tsx`,
`frontend/src/components/CheckCashingFields.tsx`,
`frontend/src/components/CheckActivity.tsx`,
`frontend/src/components/DeskPage.tsx`,
`frontend/src/components/CheckPictures.tsx`,
`frontend/src/components/CheckScanBar.tsx`, `frontend/src/lib/scanner.ts`,
`frontend/src/routes/BadChecks.tsx`, `frontend/src/components/BadCheck.tsx`,
`frontend/src/lib/micr.ts`, and the Windows app `desktop/windows/`,
`frontend/src/lib/useDeskScreen.ts`.

- **Its own app (owner, 2026-11-09).** Check cashing is a separate
  view of DineroBook, not a back office sidebar group: the top-bar
  "Back office | Check cashing" switch swaps the whole sidebar to
  `CHECK_NAV` (frontend/CLAUDE.md "Sidebar"). New check cashing pages
  live under `/check-cashing` and join `CHECK_NAV`, never `NAV`.
- **A desk program on one computer (owner, 2026-11-09).** Every page
  is a `DeskPage` (full window, no page scrolling, boxes scroll inside
  themselves, desktop only) and every new router carries
  `require_check_device` (INVARIANTS "One computer"); only the device
  routes are ungated.

- **Standalone (owner, 2026-11-07).** This module must not read or
  write the daily book, the monthly P&L, Returned checks or the
  Transfers `Customer` table, and no other module may read its tables.
  Connecting it is a later, separate decision of the owner.
- **Two switches, not one.** `check_desk` (opt-in, off) shows this
  module; the older `module_check_cashing` (on for every store) is the
  Returned checks pages and the daily-book fee boxes. Never merge them.

@INVARIANTS.md

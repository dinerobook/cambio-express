# BankSync — read before editing

Loaded automatically when Claude reads a file in this module. The full
rules (the three category families, booking, rules, rule templates,
matching, audit) are in `INVARIANTS.md`, imported below. SPA files that
count as BankSync files: `frontend/src/api/bankSync.ts`,
`routes/BankTransactions.tsx`, `routes/BankRules.tsx`,
`routes/BankMatching.tsx`, `components/BankRuleForm.tsx`.

- **Adding a bank-fed P&L line** = one `BANK_PL_CATEGORIES` row whose
  column is in `EDITABLE_MONTHLY_FIELDS`, `INCOME_FIELDS` /
  `EXPENSE_FIELDS` and `MONTHLY_LINE_DEFAULTS`. Nothing else to wire.
  `taxable_sales` / `non_taxable` are deliberately NOT bank-taggable —
  the register close already books the day's sales.
- **Built-in rules** (platform-managed bank charges) live in
  `BUILTIN_BANK_RULES` (`Services/builtin_rules.py`): each entry is
  `("DESCRIPTION SUBSTRING", "ACCOUNT_LAST4_OR_BLANK", "TARGET_KIND")`,
  matched case-insensitively, never on amount (example: Nizari
  Progressive's `REMOTE DEPOSIT FEE` on the MSB ••0230 account). They
  fire AFTER operator rules, only on still-uncategorised rows, and
  NEVER book a daily-book line. Every new entry needs a positive and a
  negative (wrong account) matcher test in
  `tests/Modules/BankSync/test_builtin_rules_service.py`.

@INVARIANTS.md

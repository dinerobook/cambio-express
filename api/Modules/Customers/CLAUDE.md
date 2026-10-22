# Customers — read before editing

`find_or_upsert_customer()` is part of the transfer ledger: the only
path that creates or updates `Customer` rows from the transfer form,
scoped to the owner umbrella (root invariant 5, detail in
`api/CLAUDE.md`). The Transfers rules are imported below.

@../Transfers/INVARIANTS.md

"""Developer — read-only tools for a superadmin signed in AS a store.

The store's Developer tab (owner, 2026-11-20: "developer tab store k
andar … tab hi dikhe jab super admin … impersonate ho k login kare")
lists every Passport file the store's register sent — what the
DineroBook Processor or the site agent uploaded — with why one did
not import, and opens any of them as raw XML. A superadmin debugs a
store from inside it, in the browser, without signing in twice.

Who may call it: only an impersonation token (``impersonated_by``)
whose impersonator is still an active superadmin. Never the store's
own people, its owner or an accountant, whatever their permissions.
The store is the token's own (``resolve_store_scope``): no store id
is read from the client. Every route is a GET, so it works on a
read-only impersonation and writes no audit row (invariant 7 covers
mutations; starting the impersonation is audited).
"""

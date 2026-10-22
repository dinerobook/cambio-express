# Auth — read before editing

Loaded automatically when Claude reads a file in this module. The full
rules are in `INVARIANTS.md`, imported below. Auth changes get an
explicit review header in the PR description.

## Invariant detail (root CLAUDE.md 10, 13, 18)

**10. Password reset** — tokens are stored as `sha256(raw)` in
`PasswordResetToken.token_hash`, single-use, 1-hour expiry. The raw
token never hits the DB, and is logged only on the SMTP-fallback path
(the URL, never on success). `/forgot-password` always answers "Check
your email", whether or not the account exists. **Superadmin is
deliberately excluded** from the email flow — an attacker who owns the
superadmin mailbox would bypass 2FA. Superadmin recovery is
`python -m scripts.reset_superadmin` on the Render shell (`--reset-2fa`
also wipes TOTP when the recovery codes are lost).

**13. 2FA (TOTP) is mandatory for superadmin — unless they sign in with
a passkey (not built yet).** The sign-in routes are the only source of
truth:
- Password sign-in for a user `needs_totp(user)` is True for returns a
  **pending** token (`LoginPendingResult`, `purpose: "totp-pending"`),
  never an access token; the SPA goes on to enrol or enter a code.
- Only the 2FA finalize step (`finalize_2fa_with_totp` /
  `finalize_2fa_with_recovery_code` in `Services/login.py`) may turn a
  pending sign-in into full access. **No other code path may issue full
  access for a role `needs_totp` is True for.**
- **Passkey carve-out (FORWARD INVARIANT — not yet implemented).**
  Passkey *registration* exists; a passkey *login* does not. When it
  lands, the passkey finish route may grant full access directly after
  verifying a WebAuthn assertion, even when `needs_totp(user)` is True:
  a passkey is phishing-resistant MFA (device-bound, user-presence-
  proven, RP-ID-bound). Full access requires a TOTP factor OR a
  verified passkey assertion; nothing else.
- Recovery codes: 10 per user, sha256-hashed, single-use
  (`RecoveryCode.used_at`), shown in plaintext exactly once.
- `User.totp_secret` is base32 plaintext in the DB — the DB is the trust
  boundary, same as `password_hash`.
- `Passkey` rows hold `(user_id, credential_id, public_key, sign_count,
  aaguid, name)`; `credential_id` is unique and the login lookup key;
  `sign_count` must be equal-or-greater (a reset means a cloned
  authenticator).
- To extend 2FA to other roles, change `_TOTP_REQUIRED_ROLES` behind
  the single `needs_totp()` predicate; never scatter role checks through
  the sign-in routes.

**18. The rank rule and the live principal.** Every route that changes
another person's role, password, active flag, custom access or saved
role goes through `api/Core/Permissions/ranks.py` (manage at or below
your own rank, assign roles at or below it, never grant what you don't
hold). A matrix body is validated in full before the first Casbin
write. `get_principal` checks the user row and the session's refresh
rows on every request, so revoking sessions, demoting, deactivating or
resetting a password signs the person out on their next call. Don't add
a user-editing route that skips the rank helpers, and don't make
`get_principal` DB-free. Every matrix route is typed by and runs through
`api/Core/Permissions/matrix_update.py` on the request's own session
(body shape 422, non-editable role 403, nothing written before the audit
row commits); sessions end only through `revoke_refresh_tokens`. Don't
write a fourth copy of that loop, and never touch
`RefreshToken.revoked_at` inline.

Casbin: one enforcer per web worker; permission writers go through the
one transactional writer (`_replace_subject_rows`) and never call
`save_policy()` or the enforcer's row-by-row API; readers reload every
`PERMISSIONS_RELOAD_SECONDS` (2 s); faults fail closed once a policy has
loaded. Never query the Casbin tables directly — use the
`api.Core.Permissions` API.

@INVARIANTS.md

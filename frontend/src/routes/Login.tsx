import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { AuthChrome } from "../components/AuthChrome";
import { Alert, Button, Field, Input, Pill } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { persistLoginResponse } from "../lib/auth";
import { autoEnterOwnerStore } from "../api/switchStore";
import styles from "./Login.module.css";
import chrome from "./auth.module.css";
import {
  readStoreChoices, type StoreChoice,
} from "./loginStoreChoices";
import type { components } from "../api/openapi";

type LoginResponse = components["schemas"]["LoginResponse"];

interface LocationState {
  from?: string;
}

interface PendingState {
  pending_token: string;
  has_recovery_codes: boolean;
}


/** SPA sign-in, inside the one auth chrome every logged-out page
 *  uses (AuthChrome). Two-step when the role requires 2FA (superadmin):
 *  step 1 POSTs creds, step 2 verifies a 6-digit TOTP or recovery
 *  code. Admin/owner/employee skip step 2 and get the token straight
 *  from /login-cross-store. */
export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState<string | null>(null);
  const [busy, setBusy]         = useState(false);
  const [pending, setPending]   = useState<PendingState | null>(null);
  const [storeChoices, setStoreChoices] =
    useState<StoreChoice[] | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const stateDest = (location.state as LocationState | null)?.from;

  async function finishLogin(result: LoginResponse) {
    persistLoginResponse({
      user_id:     result.user_id,
      username:    result.username ?? "",
      full_name:   result.full_name ?? "",
      role:        result.role ?? "",
      store_id:    result.store_id ?? null,
      permissions: result.permissions ?? [],
      refresh_jti: result.refresh_jti ?? undefined,
    });
    // Single-dashboard rule (U-4a): an owner lands inside a store —
    // the same view their team sees — not on a separate owner
    // surface. Remembered store → home store → first store; the
    // owner overview stays reachable via the store switcher. Only
    // an owner with no active stores falls back to the overview.
    if (result.role === "owner") {
      const entered = await autoEnterOwnerStore();
      navigate(
        entered ? (stateDest || "/dashboard") : "/owner/dashboard",
        { replace: true },
      );
      return;
    }
    navigate(stateDest || "/dashboard", { replace: true });
  }

  async function handleResult(result: LoginResponse) {
    if (result.requires_totp && result.pending_token) {
      if (result.enroll_required) {
        navigate("/login/2fa/enroll", {
          state: { pending_token: result.pending_token },
          replace: true,
        });
        return;
      }
      setPending({
        pending_token: result.pending_token,
        has_recovery_codes: result.has_recovery_codes ?? false,
      });
      return;
    }
    await finishLogin(result);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await api<LoginResponse>("/api/v2/auth/login-cross-store", {
        method: "POST",
        json: { username: username.trim(), password },
      });
      await handleResult(result);
    } catch (err) {
      // Credentials good at more than one store — ask which, rather
      // than guessing or refusing. Usernames are unique per store,
      // so the same person can legitimately exist at several.
      const choices = readStoreChoices(err);
      if (choices) {
        setStoreChoices(choices);
      } else {
        setError(err instanceof ApiError ? err.message : "Network error. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  /** Re-submit with the store the user picked. */
  async function onPickStore(storeId: number) {
    setError(null);
    setBusy(true);
    try {
      const result = await api<LoginResponse>("/api/v2/auth/login", {
        method: "POST",
        json: {
          username: username.trim(), password, store_id: storeId,
        },
      });
      await handleResult(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Network error. Please try again.");
      setStoreChoices(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome navLink={{ to: "/signup", label: "Create an account" }}>
      <div className={chrome.stack}>
      {pending ? (
        <SecondFactor
          state={pending}
          onSuccess={finishLogin}
          onCancel={() => { setPending(null); setError(null); }}
        />
      ) : storeChoices ? (
        <StorePicker
          choices={storeChoices}
          busy={busy}
          error={error}
          onPick={(id) => { void onPickStore(id); }}
          onCancel={() => { setStoreChoices(null); setError(null); }}
        />
      ) : (
        <PrimaryForm
          username={username} setUsername={setUsername}
          password={password} setPassword={setPassword}
          error={error}
          busy={busy}
          onSubmit={onSubmit}
        />
      )}
      </div>
    </AuthChrome>
  );
}


function PrimaryForm({
  username, setUsername, password, setPassword, error, busy, onSubmit,
}: {
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  error: string | null;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
}) {
  return (
    <>
      <h2 className={chrome.cardTitle} style={{ margin: 0 }}>Sign in</h2>
      <p className={chrome.cardSub} style={{ margin: 0 }}>Welcome back. Pick up where you left off.</p>

      {error && <Alert tone="error">{error}</Alert>}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <Field label="Email or phone">
          <Input
            type="text"
            placeholder="you@store.com or (555) 123-4567"
            autoFocus required
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          label={
            <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Password</span>
              <Link
                to="/forgot-password"
                style={{ fontSize: "0.78rem", color: "var(--db-neon)", fontWeight: 500, textDecoration: "none" }}
              >
                Forgot?
              </Link>
            </span>
          }
        >
          <Input
            type="password"
            placeholder="••••••••"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Button
          type="submit"
          tone="primary"
          size="lg"
          busy={busy}
          disabled={busy || !username || !password}
          style={{ width: "100%" }}
        >
          {busy ? "Signing in…" : "Sign in →"}
        </Button>
      </form>

      {/* The "Employee? Enter your store code" box that used to sit
          here is gone. Everyone — owner, admin, employee — signs in
          with the form above; sending cashiers off to a slug-scoped
          page was the last thing making a simple sign-in feel
          complicated. /login/:slug still resolves for old bookmarks. */}

      <div className={chrome.centerRow}>
        New to DineroBook? <Link to="/signup">Create an account →</Link>
      </div>

      {/* No uptime or encryption badges here: a claim on a sign-in
          page is either backed by a status page or it is decoration
          pretending to be one. */}
      <div className={chrome.footer}>
        <div className={chrome.copyright}>
          © 2026 DineroBook · <a href="/privacy">Privacy</a>
        </div>
      </div>
    </>
  );
}


/** "Which store?" step. Only reachable once the password has
 *  already been verified, so listing the stores here reveals
 *  nothing the person doesn't already have access to. */
function StorePicker({
  choices, busy, error, onPick, onCancel,
}: {
  choices: StoreChoice[];
  busy: boolean;
  error: string | null;
  onPick: (storeId: number) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <h2 className={chrome.cardTitle} style={{ margin: 0 }}>Which store?</h2>
      <p className={chrome.cardSub} style={{ margin: 0 }}>
        Your sign-in works at more than one store. Pick the one you
        want to open.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <div className={styles.storeChoices}>
        {choices.map((c) => (
          <button
            key={c.store_id}
            type="button"
            className={styles.storeChoice}
            onClick={() => onPick(c.store_id)}
            disabled={busy}
          >
            <span className={styles.storeChoiceName}>
              {c.store_name || `Store #${c.store_id}`}
            </span>
            {c.role && (
              <span className={styles.storeChoiceRole}>{c.role}</span>
            )}
          </button>
        ))}
      </div>

      <Button
        type="button" tone="secondary" size="lg"
        onClick={onCancel} disabled={busy}
        style={{ width: "100%" }}
      >
        Back
      </Button>
    </>
  );
}


function SecondFactor({
  state, onSuccess, onCancel,
}: {
  state: PendingState;
  onSuccess: (result: LoginResponse) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [mode, setMode]   = useState<"totp" | "recovery">("totp");
  const [code, setCode]   = useState("");
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    const url =
      mode === "totp"
        ? "/api/v2/auth/login/totp"
        : "/api/v2/auth/login/recovery";
    try {
      const result = await api<LoginResponse>(url, {
        method: "POST",
        json: { pending_token: state.pending_token, code: code.trim() },
      });
      if (result.access_token) {
        await onSuccess(result);
      } else {
        setError("Server returned an unexpected response.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Pill tone="accent" dot mono>TWO-FACTOR REQUIRED</Pill>
      <h2 className={chrome.cardTitle} style={{ margin: 0 }}>Verify your identity</h2>
      <p className={chrome.cardSub} style={{ margin: 0 }}>
        {mode === "totp"
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of your single-use recovery codes."}
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <Field label={mode === "totp" ? "Verification code" : "Recovery code"}>
          <Input
            type="text"
            autoComplete="one-time-code"
            autoFocus required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
            inputMode={mode === "totp" ? "numeric" : "text"}
            pattern={mode === "totp" ? "[0-9]*" : undefined}
            placeholder={mode === "totp" ? "123456" : "ABCD-1234"}
            style={{
              fontFamily: "var(--db-font-mono)",
              fontSize: "1.15rem",
              letterSpacing: "0.1em",
            }}
          />
        </Field>
        <Button
          type="submit"
          tone="primary"
          size="lg"
          busy={busy}
          disabled={busy || !code}
          style={{ width: "100%" }}
        >
          {busy ? "Verifying…" : "Verify →"}
        </Button>
      </form>

      <div className={chrome.formActions}>
        {mode === "totp" && state.has_recovery_codes && (
          <Button
            tone="ghost"
            onClick={() => { setMode("recovery"); setCode(""); setError(null); }}
          >
            Use a recovery code
          </Button>
        )}
        {mode === "recovery" && (
          <Button
            tone="ghost"
            onClick={() => { setMode("totp"); setCode(""); setError(null); }}
          >
            Back to authenticator code
          </Button>
        )}
        <Button tone="ghost" onClick={onCancel}>Cancel</Button>
      </div>

      <div className={chrome.footer}>
        <div className={chrome.copyright}>
          © 2026 DineroBook · <a href="/privacy">Privacy</a>
        </div>
      </div>
    </>
  );
}


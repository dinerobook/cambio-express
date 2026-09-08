import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { lookupStoreBySlug, type StoreLookup } from "../api/account";
import { AuthChrome, StatusPill } from "../components/AuthChrome";
import { Alert, Button, Field, Input, Loading } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { setAccessToken } from "../lib/auth";
import { BRAND_NAME } from "../lib/brand";
import styles from "./auth.module.css";

interface LoginResponse {
  access_token: string;
}

// Per-store employee sign-in at /app/login/:slug. Same chrome as
// every other logged-out page (AuthChrome) — it used to carry its
// own split-screen stylesheet, the third copy of the auth shell.
//
// Form contract: submit username + password to /api/v2/auth/login
// scoped to the resolved store_id. The backend sets the
// `ds_last_store` cookie automatically (legacy parity) so an
// installed-PWA employee with cleared session still gets bounced
// here on next visit.
export default function LoginStore() {
  const { slug = "" } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [store,    setStore]    = useState<StoreLookup | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset loading/error/store flags before async lookup of the store by slug; cancellation flag guards stale resolutions
    setLoading(true); setNotFound(false); setStore(null);
    lookupStoreBySlug(slug).then(
      (s) => {
        if (cancelled) return;
        if (s === null) setNotFound(true); else setStore(s);
        setLoading(false);
      },
      () => {
        if (!cancelled) { setNotFound(true); setLoading(false); }
      },
    );
    return () => { cancelled = true; };
  }, [slug]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!store) return;
    setError(null); setBusy(true);
    try {
      const result = await api<LoginResponse>("/api/v2/auth/login", {
        method: "POST",
        json: {
          username: username.trim(),
          password,
          store_id: store.store_id,
        },
      });
      setAccessToken(result.access_token);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Network error. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome navLink={{ to: "/login", label: "Sign in another way" }}>
      {loading ? (
        <Loading />
      ) : notFound || !store ? (
        <>
          <div className={styles.cardTitle}>Store not found</div>
          <div className={styles.cardSub}>
            We couldn't find a store with that code. Check with your
            manager for the correct URL.
          </div>
          <Link to="/login" className={styles.backLink}>← Back to sign in</Link>
        </>
      ) : (
        <div className={styles.stack}>
          <StatusPill>SECURE · {store.name.toUpperCase()}</StatusPill>
          <div>
            <div className={styles.cardTitle}>Employee sign in</div>
            <div className={styles.cardSub} style={{ marginBottom: 0 }}>
              Sign in with the username your store admin gave you.
            </div>
          </div>

          {error && <Alert tone="error">{error}</Alert>}

          <form
            onSubmit={onSubmit}
            style={{ display: "flex", flexDirection: "column", gap: "0.95rem" }}
          >
            <Field label="Username">
              <Input
                type="text"
                placeholder="your-username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={busy}
                required
                autoFocus
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
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

          <div className={styles.storeLine}>{store.name} · {BRAND_NAME}</div>
        </div>
      )}
    </AuthChrome>
  );
}

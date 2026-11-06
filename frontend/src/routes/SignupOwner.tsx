import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { AuthChrome } from "../components/AuthChrome";
import { Alert, Button, Field, Input } from "../components/ui";
import { signupOwner } from "../api/account";
import { ApiError } from "../lib/api";
import { setAccessToken } from "../lib/auth";
import styles from "./auth.module.css";
import { useT } from "../i18n";

// Multi-store owner signup at /app/signup/owner. Creates the owner
// user + JWT; the owner connects/redeems individual store codes
// later through the dashboard.
export default function SignupOwner() {
  const t = useT();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [busy,     setBusy]     = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [errors,   setErrors]   = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setErrors({});
    setBusy(true);
    try {
      const result = await signupOwner({
        full_name: fullName.trim(),
        email:     email.trim(),
        password,
      });
      setAccessToken(result.access_token);
      navigate("/owner/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        const detail = (err.body as { detail?: { field?: string; message?: string } } | null)?.detail;
        if (detail?.field && detail?.message) {
          setErrors({ [detail.field]: detail.message });
          setError(null);
        }
      } else {
        setError(t("signup.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome navLink={{ to: "/login", label: t("signup.signInNav") }}>
      <div className={styles.badgePill}>{t("signupOwner.pill")}</div>
      <div className={styles.cardTitle}>{t("signupOwner.title")}</div>
      <div className={styles.cardSub}>{t("signupOwner.subtitle")}</div>

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.95rem" }}>
        {error && <Alert tone="error">{error}</Alert>}

        <Field label={t("signupOwner.fullName")} error={errors.full_name}>
          <Input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t("signupOwner.fullNamePlaceholder")}
            disabled={busy}
            required
          />
        </Field>
        <Field label={t("common.email")} error={errors.email}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("signupOwner.emailPlaceholder")}
            autoComplete="email"
            disabled={busy}
            required
          />
        </Field>
        <Field label={t("login.password")} error={errors.password}>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("signup.passwordPlaceholder")}
            autoComplete="new-password"
            minLength={8}
            disabled={busy}
            required
          />
        </Field>
        <Button
          type="submit"
          tone="primary"
          size="lg"
          busy={busy}
          disabled={busy || !fullName || !email || !password}
          style={{ width: "100%" }}
        >
          {busy ? t("signupOwner.creating") : t("signupOwner.submit")}
        </Button>
      </form>

      <div className={styles.loginPrompt}>
        {t("signup.haveAccount")} <Link to="/login">{t("signup.signIn")}</Link>
      </div>
      <div className={styles.loginPrompt} style={{ marginTop: 10 }}>
        {t("signupOwner.singleStore")} <Link to="/signup">{t("signupOwner.signUpStore")}</Link>
      </div>
    </AuthChrome>
  );
}

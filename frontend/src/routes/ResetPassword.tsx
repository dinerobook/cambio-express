import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthChrome, StatusPill } from "../components/AuthChrome";
import { Alert, Button, ButtonLink, Field, Input } from "../components/ui";
import { resetPassword } from "../api/account";
import { apiErrorMessage } from "../lib/api";
import styles from "./auth.module.css";
import { useT } from "../i18n";

// /app/reset-password?token=… — consume a one-time token to set
// a new password. Token comes from the email link.
export default function ResetPassword() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const token = sp.get("token") ?? "";
  const [pw,      setPw]      = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [done,    setDone]    = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw !== confirm) {
      setError(t("reset.mismatch"));
      return;
    }
    if (pw.length < 8) {
      setError(t("reset.tooShort"));
      return;
    }
    setBusy(true);
    try {
      await resetPassword({
        token,
        new_password: pw,
        confirm_password: confirm,
      });
      setDone(true);
    } catch (err) {
      setError(
        apiErrorMessage(err, t("reset.failed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthChrome navLink={{ to: "/login", label: t("login.backToSignIn") }}>
      {!token ? (
        <>
          <StatusPill tone="error">{t("reset.missingPill")}</StatusPill>
          <div className={styles.cardTitle}>{t("reset.missingTitle")}</div>
          <div className={styles.cardSub}>
            {t("reset.missingHint")}
          </div>
          <ButtonLink to="/forgot-password" tone="primary" size="lg" style={{ width: "100%" }}>
            {t("reset.requestNew")}
          </ButtonLink>
          <Link to="/login" className={styles.backLink}>{t("login.backToSignIn")}</Link>
        </>
      ) : done ? (
        <>
          <StatusPill>{t("reset.donePill")}</StatusPill>
          <div className={styles.cardTitle}>{t("reset.doneTitle")}</div>
          <div className={styles.cardSub}>
            {t("reset.doneHint")}
          </div>
          <Button
            tone="primary"
            size="lg"
            style={{ width: "100%" }}
            onClick={() => navigate("/login")}
          >
            {t("login.submit")}
          </Button>
        </>
      ) : (
        <>
          <StatusPill>{t("reset.pill")}</StatusPill>
          <div className={styles.cardTitle}>{t("reset.title")}</div>
          <div className={styles.cardSub}>{t("reset.subtitle")}</div>

          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.95rem" }}>
            {error && <Alert tone="error">{error}</Alert>}

            <Field label={t("reset.newPassword")}>
              <Input
                type="password"
                autoComplete="new-password"
                minLength={8}
                placeholder={t("reset.newPasswordPlaceholder")}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
                required
                autoFocus
              />
            </Field>
            <Field label={t("reset.confirmPassword")}>
              <Input
                type="password"
                autoComplete="new-password"
                minLength={8}
                placeholder={t("reset.confirmPlaceholder")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                required
              />
            </Field>
            <Button
              type="submit"
              tone="primary"
              size="lg"
              busy={busy}
              disabled={busy || !pw || !confirm}
              style={{ width: "100%" }}
            >
              {busy ? t("reset.submitting") : t("reset.submit")}
            </Button>
          </form>
          <Link to="/login" className={styles.backLink}>{t("login.backToSignIn")}</Link>
        </>
      )}
    </AuthChrome>
  );
}

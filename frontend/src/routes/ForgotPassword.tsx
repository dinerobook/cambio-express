import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import { AuthChrome, StatusPill } from "../components/AuthChrome";
import { Button, Field, Input } from "../components/ui";
import { forgotPassword } from "../api/account";
import styles from "./auth.module.css";
import { useT } from "../i18n";

// /app/forgot-password — request a reset link.
//
// Per CLAUDE.md security invariant #10 the response is always
// "Check your email" regardless of whether the address exists,
// so attackers can't enumerate registered emails.
export default function ForgotPassword() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [busy,  setBusy]  = useState(false);
  const [done,  setDone]  = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await forgotPassword(email.trim());
    } catch {
      // Server responds 200 even on unknown email; flip to success
      // either way so we don't leak whether the address was registered.
    } finally {
      setBusy(false);
      setDone(true);
    }
  }

  return (
    <AuthChrome navLink={{ to: "/login", label: t("login.backToSignIn") }}>
      {done ? (
        <>
          <StatusPill>{t("forgot.sentPill")}</StatusPill>
          <div className={styles.cardTitle}>{t("forgot.sentTitle")}</div>
          <div className={styles.cardSub}>
            {t("forgot.sentBefore")} <span className={styles.subMono}>{email}</span>{" "}
            {t("forgot.sentAfter")}
          </div>
          <Link to="/login" className={styles.backLink}>{t("login.backToSignIn")}</Link>
        </>
      ) : (
        <>
          <StatusPill>{t("forgot.pill")}</StatusPill>
          <div className={styles.cardTitle}>{t("forgot.title")}</div>
          <div className={styles.cardSub}>
            {t("forgot.subtitle")}
          </div>
          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.95rem" }}>
            <Field label={t("forgot.email")}>
              <Input
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
                autoFocus
              />
            </Field>
            <Button
              type="submit"
              tone="primary"
              size="lg"
              busy={busy}
              disabled={busy || !email}
              style={{ width: "100%" }}
            >
              {busy ? t("forgot.submitting") : t("forgot.submit")}
            </Button>
          </form>
          <Link to="/login" className={styles.backLink}>{t("login.backToSignIn")}</Link>
        </>
      )}
    </AuthChrome>
  );
}

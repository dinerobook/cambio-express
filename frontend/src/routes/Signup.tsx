import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthChrome, StatusPill } from "../components/AuthChrome";
import { Alert, Button, Field, Input, Select } from "../components/ui";
import { previewReferral, signup, type ReferralPreview } from "../api/account";
import { autoEnterOwnerStore } from "../api/switchStore";
import { ApiError } from "../lib/api";
import { persistLoginResponse } from "../lib/auth";
import styles from "./auth.module.css";
import { fmtMoney } from "../lib/formatters";
import { tNodes, useT } from "../i18n";

// Owner-first signup at /app/signup (U-4b). Creates a store + its
// OWNER user + JWT in one POST, then auto-enters the new store so
// the first thing the owner sees is the same dashboard their team
// will see. Optional ?ref= preview reads /referral/<code> to show
// the inline "$X off" banner before the user submits.
export default function Signup() {
  const t = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const refFromUrl = (params.get("ref") || "").toUpperCase();

  const [storeName, setStoreName] = useState("");
  const [email,     setEmail]     = useState("");
  const [phone,     setPhone]     = useState("");
  const [password,  setPassword]  = useState("");
  const [refCode,   setRefCode]   = useState(refFromUrl);
  const [bizType,   setBizType]   = useState("cstore");
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [errors,    setErrors]    = useState<Record<string, string>>({});
  const [referral,  setReferral]  = useState<ReferralPreview | null>(null);

  useEffect(() => {
    const code = refCode.trim().toUpperCase();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- debounced referral-code preview: clear local referral state when the input empties (the .then callback below sets it for non-empty codes)
    if (!code) { setReferral(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewReferral(code).then(
        (r) => { if (!cancelled) setReferral(r); },
        () => { if (!cancelled) setReferral(null); },
      );
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [refCode]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setErrors({});
    setBusy(true);
    try {
      const result = await signup({
        store_name: storeName.trim(),
        email:      email.trim(),
        password,
        phone:      phone.trim(),
        ref_code:   refCode.trim().toUpperCase(),
        business_type: bizType,
      });
      persistLoginResponse(result);
      // Enter the brand-new store right away (single-dashboard
      // rule) — a failure still lands somewhere sane: /home
      // bounces to /dashboard, whose owner fallback shows the
      // owner overview.
      await autoEnterOwnerStore();
      navigate("/home", { replace: true });
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
      <StatusPill>{t("signup.trialPill")}</StatusPill>
      <div className={styles.cardTitle}>{t("signup.title")}</div>
      <div className={styles.cardSub}>{t("signup.subtitle")}</div>

      {referral && (
        <div className={styles.referralBanner}>
          {tNodes("signup.referral", {
            amount: <strong>{fmtMoney(referral.reward_referee_cents / 100)}</strong>,
          })}
        </div>
      )}

      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.95rem" }}>
        {error && <Alert tone="error">{error}</Alert>}

        <Field label={t("signup.storeName")} error={errors.store_name}>
          <Input
            type="text"
            value={storeName}
            onChange={(e) => setStoreName(e.target.value)}
            placeholder={t("signup.storeNamePlaceholder")}
            disabled={busy}
            required
          />
        </Field>
        <Field label={t("signup.businessType")}>
          <Select
            value={bizType}
            onChange={(e) => setBizType(e.target.value)}
            disabled={busy}
          >
            <option value="cstore">{t("signup.bizCstore")}</option>
            <option value="gas_station">{t("signup.bizGas")}</option>
            <option value="grocery">{t("signup.bizGrocery")}</option>
            <option value="msb_hybrid">{t("signup.bizMsb")}</option>
          </Select>
        </Field>
        <Field label={t("signup.storeEmail")} error={errors.email}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("signup.emailPlaceholder")}
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
        <Field label={<>{tNodes("signup.phoneLabel", { optional: <span className={styles.optional}>{t("signup.optional")}</span> })}</>}>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="555-000-0000"
            autoComplete="tel"
            disabled={busy}
          />
        </Field>
        <Field label={<>{tNodes("signup.referralLabel", { optional: <span className={styles.optional}>{t("signup.optional")}</span> })}</>}>
          <Input
            type="text"
            value={refCode}
            onChange={(e) => setRefCode(e.target.value.toUpperCase())}
            placeholder={t("signup.referralPlaceholder")}
            maxLength={12}
            disabled={busy}
            style={{
              textTransform: "uppercase",
              fontFamily: "var(--db-font-mono)",
              letterSpacing: "2px",
            }}
          />
        </Field>
        <Button
          type="submit"
          tone="primary"
          size="lg"
          busy={busy}
          disabled={busy || !storeName || !email || !password}
          style={{ width: "100%" }}
        >
          {busy ? t("signup.creating") : t("signup.start")}
        </Button>
      </form>

      <div className={styles.loginPrompt}>
        {t("signup.haveAccount")} <Link to="/login">{t("signup.signIn")}</Link>
      </div>
    </AuthChrome>
  );
}

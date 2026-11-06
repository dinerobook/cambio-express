import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { AuthChrome } from "../components/AuthChrome";
import {
  Alert, Button, Checkbox, Field, Input, Loading,
} from "../components/ui";
import { api, apiErrorMessage } from "../lib/api";
import { setAccessToken } from "../lib/auth";
import {
  totpEnrollConfirm, totpEnrollFinish, totpEnrollStart,
  type TotpEnrollStartResponse,
} from "../api/account";
import styles from "./TwoFactor.module.css";
import chrome from "./auth.module.css";
import { t as translate, tNodes, useT } from "../i18n";

// Samples of what to type: the same in every language.
const TOTP_SAMPLE = "123 456";
const RECOVERY_SAMPLE = "ABCD-EFGH";
const TITLE_SUFFIX = " — DineroBook";

interface PendingState {
  pending_token: string;
  has_recovery_codes?: boolean;
}

function readPending(loc: ReturnType<typeof useLocation>): PendingState | null {
  // Tokens are passed via React Router state (not URL) so they
  // never appear in browser history or referer headers.
  const s = (loc.state ?? null) as PendingState | null;
  if (s && typeof s.pending_token === "string" && s.pending_token) return s;
  return null;
}


export function TwoFactorVerify() {
  const t = useT();
  const navigate = useNavigate();
  const loc = useLocation();
  const pending = readPending(loc);
  useEffect(() => {
    if (!pending) navigate("/login", { replace: true });
  }, [pending, navigate]);
  if (!pending) return null;
  return (
    <Chrome title={t("tfa.verifyDocTitle")}>
      <VerifyForm
        endpoint="/api/v2/auth/login/totp"
        heading={t("tfa.verifyHeading")}
        sub={t("tfa.verifySub")}
        codeLabel={t("tfa.codeLabel")}
        codeMode="numeric"
        codePlaceholder={TOTP_SAMPLE}
        codeMaxLen={7}
        codePattern="[0-9 ]*"
        submitLabel={t("tfa.verify")}
        pending={pending}
      >
        {pending.has_recovery_codes && (
          <div className={chrome.centerRow}>
            {t("tfa.lostDevice")}{" "}
            <Link to="/login/2fa/recover" state={pending}>
              {t("tfa.useRecovery")}
            </Link>
          </div>
        )}
        <div className={chrome.centerRow}>
          <Link to="/login">{t("tfa.cancel")}</Link>
        </div>
      </VerifyForm>
    </Chrome>
  );
}


export function TwoFactorRecover() {
  const t = useT();
  const navigate = useNavigate();
  const loc = useLocation();
  const pending = readPending(loc);
  useEffect(() => {
    if (!pending) navigate("/login", { replace: true });
  }, [pending, navigate]);
  if (!pending) return null;
  return (
    <Chrome title={t("tfa.useRecovery")}>
      <VerifyForm
        endpoint="/api/v2/auth/login/recovery"
        heading={t("tfa.useRecovery")}
        sub={t("tfa.recoverSub")}
        codeLabel={t("tfa.recoveryLabel")}
        codeMode="text"
        codePlaceholder={RECOVERY_SAMPLE}
        codeMaxLen={16}
        submitLabel={t("tfa.useCode")}
        pending={pending}
        uppercase
      >
        <div className={chrome.centerRow}>
          {t("tfa.gotBack")}{" "}
          <Link to="/login/2fa" state={pending}>
            {t("tfa.useSixDigit")}
          </Link>
        </div>
        <div className={chrome.centerRow}>
          <Link to="/login">{t("tfa.cancel")}</Link>
        </div>
      </VerifyForm>
    </Chrome>
  );
}


type EnrollStep = "scan" | "saved";


export function TwoFactorEnroll() {
  const t = useT();
  const navigate = useNavigate();
  const loc = useLocation();
  const pending = readPending(loc);
  const [enrollment, setEnrollment] = useState<TotpEnrollStartResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [step, setStep] = useState<EnrollStep>("scan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [savedConfirmed, setSavedConfirmed] = useState(false);

  useEffect(() => {
    if (!pending) {
      navigate("/login", { replace: true });
      return;
    }
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mark busy before kicking off the async TOTP-enrollment fetch; cancellation flag guards stale resolutions
    setBusy(true);
    totpEnrollStart(pending.pending_token)
      .then((data) => { if (!cancelled) setEnrollment(data); })
      .catch((err) => {
        if (cancelled) return;
        setError(
          apiErrorMessage(err, translate("tfa.startFailed")),
        );
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [pending, navigate]);

  if (!pending) return null;

  async function onVerifyCode(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError(null); setBusy(true);
    try {
      const r = await totpEnrollFinish(pending.pending_token, code.trim());
      setRecoveryCodes(r.recovery_codes);
      setStep("saved");
    } catch (err) {
      setError(
        apiErrorMessage(err, t("tfa.noMatch")),
      );
    } finally { setBusy(false); }
  }

  async function onConfirmSaved(e: FormEvent) {
    e.preventDefault();
    if (!pending || !savedConfirmed) return;
    setError(null); setBusy(true);
    try {
      const r = await totpEnrollConfirm(pending.pending_token);
      if ("access_token" in r && typeof r.access_token === "string") {
        setAccessToken(r.access_token);
        navigate("/dashboard", { replace: true });
      } else {
        setError(t("common.unexpectedResponse"));
      }
    } catch (err) {
      setError(
        apiErrorMessage(err, t("tfa.finalizeFailed")),
      );
    } finally { setBusy(false); }
  }

  if (step === "saved" && recoveryCodes) {
    return (
      <Chrome title={t("tfa.saveDocTitle")}>
        <h2 className={chrome.cardTitle} style={{ margin: 0 }}>{t("tfa.saveHeading")}</h2>
        <p className={chrome.cardSub} style={{ margin: 0 }}>
          {t("tfa.saveSub")}
        </p>
        <Alert tone="info">
          <strong>{t("tfa.whereStore")}</strong> {t("tfa.whereStoreBody")}
        </Alert>
        <div className={styles.recoveryGrid}>
          {recoveryCodes.map((c) => (<div key={c}>{c}</div>))}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <form onSubmit={onConfirmSaved} autoComplete="off"
              style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
          <Checkbox checked={savedConfirmed} onChange={setSavedConfirmed}>
            {t("tfa.savedConfirm")}
          </Checkbox>
          <Button
            type="submit" tone="primary" size="lg"
            busy={busy}
            disabled={!savedConfirmed || busy}
            style={{ width: "100%" }}
          >
            {busy ? t("tfa.finishing") : t("tfa.finish")}
          </Button>
        </form>
      </Chrome>
    );
  }

  return (
    <Chrome title={t("tfa.setupDocTitle")}>
      <h2 className={chrome.cardTitle} style={{ margin: 0 }}>{t("tfa.setupHeading")}</h2>
      <p className={chrome.cardSub} style={{ margin: 0 }}>
        {t("tfa.setupSub")}
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {!enrollment ? (
        <Loading />
      ) : (
        <>
          <div
            className={styles.qrWrap}
            dangerouslySetInnerHTML={{ __html: enrollment.qr_svg }}
          />
          <Alert tone="info">
            <strong>{t("tfa.cantScan")}</strong>{" "}
            {tNodes("tfa.manual", {
              issuer: <code>{enrollment.issuer}</code>,
              account: <code>{enrollment.username}</code>,
            })}
          </Alert>
          <div className={styles.secretBlock}>{enrollment.secret_chunks}</div>
          <form onSubmit={onVerifyCode} autoComplete="off"
                style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
            <Field label={t("tfa.enterCode")}>
              <Input
                type="text" inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]*" maxLength={7}
                placeholder={TOTP_SAMPLE} autoFocus required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={busy}
                style={{
                  fontFamily: "var(--db-font-mono)",
                  fontSize: 20,
                  letterSpacing: 6,
                  textAlign: "center",
                }}
              />
            </Field>
            <Button
              type="submit" tone="primary" size="lg"
              busy={busy}
              disabled={busy || !code}
              style={{ width: "100%" }}
            >
              {busy ? t("tfa.verifying") : t("tfa.confirm")}
            </Button>
          </form>
        </>
      )}
      <div className={chrome.centerRow}>
        <Link to="/login">{t("tfa.cancel")}</Link>
      </div>
    </Chrome>
  );
}


function VerifyForm({
  endpoint, heading, sub, codeLabel, codeMode, codePlaceholder,
  codeMaxLen, codePattern, submitLabel, pending, uppercase, children,
}: {
  endpoint: string;
  heading: string;
  sub: string;
  codeLabel: string;
  codeMode: "numeric" | "text";
  codePlaceholder: string;
  codeMaxLen: number;
  codePattern?: string;
  submitLabel: string;
  pending: PendingState;
  uppercase?: boolean;
  children?: ReactNode;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await api<{ access_token: string }>(endpoint, {
        method: "POST",
        json: { pending_token: pending.pending_token, code: code.trim() },
      });
      if (r.access_token) {
        setAccessToken(r.access_token);
        navigate("/dashboard", { replace: true });
      } else {
        setError(t("common.unexpectedResponse"));
      }
    } catch (err) {
      setError(apiErrorMessage(err, t("common.networkError")));
    } finally { setBusy(false); }
  }

  return (
    <>
      <h2 className={chrome.cardTitle} style={{ margin: 0 }}>{heading}</h2>
      <p className={chrome.cardSub} style={{ margin: 0 }}>{sub}</p>
      {error && <Alert tone="error">{error}</Alert>}
      <form onSubmit={onSubmit} autoComplete="off"
            style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
        <Field label={codeLabel}>
          <Input
            type="text" inputMode={codeMode}
            autoComplete="one-time-code"
            pattern={codePattern}
            maxLength={codeMaxLen}
            placeholder={codePlaceholder} autoFocus required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
            style={{
              fontFamily: "var(--db-font-mono)",
              fontSize: codeMode === "numeric" ? 20 : 18,
              letterSpacing: codeMode === "numeric" ? 6 : 2,
              textAlign: "center",
              textTransform: uppercase ? "uppercase" : undefined,
            }}
          />
        </Field>
        <Button
          type="submit" tone="primary" size="lg"
          busy={busy}
          disabled={busy || !code}
          style={{ width: "100%" }}
        >
          {busy ? t("tfa.verifying") : submitLabel}
        </Button>
      </form>
      {children}
    </>
  );
}


/** The 2FA screens live in the same chrome as every other
 *  logged-out page. A "Cancel" back to /login is inside each
 *  screen, so the nav carries no link. */
function Chrome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <AuthChrome navLink={null}>
        <div className={chrome.stack}>{children}</div>
      </AuthChrome>
      <DocTitle title={title + TITLE_SUFFIX} />
    </>
  );
}


function DocTitle({ title }: { title: string }) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
  return null;
}


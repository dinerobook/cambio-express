import { Link } from "react-router-dom";
import type { ReactNode } from "react";

import styles from "../routes/auth.module.css";
import { BRAND_NAME } from "../lib/brand";

/** Shared chrome for every logged-out page (Login, TwoFactor,
 *  ForgotPassword, ResetPassword, Signup, SignupOwner, ...).
 *  Renders the sticky nav + the backdrop + the card. Children are
 *  the inner card contents (status pill, heading, form, etc.).
 *
 *  `aside` turns the page into two halves: the aside on the left,
 *  the card on the right. The card comes first in the markup, so
 *  on narrow screens (where the halves stack) and for keyboard and
 *  screen-reader users the form is still the first thing. */
export function AuthChrome({
  navLink,
  aside,
  children,
}: {
  /** Right-side nav link. Pass `null` for no link. */
  navLink: { to: string; label: string } | null;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <nav className={styles.nav}>
        <Link to="/" className={styles.navBrand}>
          <img className={styles.navBrandMark} src="/static/brand-mark.svg" alt="" />
          <span className={styles.navBrandName}>{BRAND_NAME}</span>
        </Link>
        {navLink && (
          <Link to={navLink.to} className={styles.navLink}>{navLink.label}</Link>
        )}
      </nav>

      <div className={styles.page}>
        <div className={styles.grid} aria-hidden="true" />
        <div className={styles.glow} aria-hidden="true" />

        {aside ? (
          <div className={styles.split}>
            <div className={`${styles.card} ${styles.splitCard}`}>
              {children}
            </div>
            <div className={styles.splitAside}>{aside}</div>
          </div>
        ) : (
          <div className={styles.card}>
            {children}
          </div>
        )}
      </div>
    </>
  );
}


/** "Status pill" — green-dot + uppercase label, sits at the top
 *  of the card. Used by every auth route to hint at flow state
 *  (PASSWORD RESET, ✓ EMAIL SENT, START YOUR TRIAL, etc.).
 *  Pass `tone="error"` for the red variant. */
export function StatusPill({
  children, tone,
}: {
  children: ReactNode;
  tone?: "neutral" | "error";
}) {
  const cls = tone === "error"
    ? `${styles.statusPill} ${styles.statusPillError}`
    : styles.statusPill;
  return (
    <div className={cls}>
      <span className={styles.pillDot} />
      <span className={styles.pillLabel}>{children}</span>
    </div>
  );
}

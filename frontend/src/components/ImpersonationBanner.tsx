import { useState } from "react";

import { useSessionStatus } from "../api/account";
import { getCurrentIdentity } from "../lib/auth";
import { stopImpersonation } from "../lib/impersonation";
import { Button } from "./ui";
import styles from "./ImpersonationBanner.module.css";

// Shown above every authed page while a superadmin is signed in AS
// a customer (`session-status.impersonation` is set — the token
// carries `impersonated_by`). It names who they are acting as, says
// the actions are recorded, and offers the one way back.
//
// Reads the server's answer, not local state: a reload, a second
// tab, or a silent refresh that already flipped the session back
// to the superadmin all render correctly without bookkeeping.

export function ImpersonationBanner() {
  const { data } = useSessionStatus();
  if (!data?.impersonation) return null;
  const identity = getCurrentIdentity();
  return (
    <ImpersonationBannerView
      actingAs={identity?.full_name || identity?.username || "this user"}
      role={identity?.role ?? ""}
      storeName={data.store_name}
      byName={data.impersonation.by_name}
      readOnly={data.impersonation.read_only}
      onExit={stopImpersonation}
    />
  );
}

export function ImpersonationBannerView({
  actingAs, role, storeName, byName, readOnly = false, onExit,
}: {
  actingAs: string;
  role: string;
  storeName: string;
  byName: string;
  /** A read-only session: the server refuses every write, so the
   *  banner says so instead of warning that actions are recorded. */
  readOnly?: boolean;
  onExit: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  async function exit() {
    setBusy(true);
    try {
      await onExit();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={styles.bar} role="status" data-testid="impersonation-banner"
      data-read-only={readOnly ? "true" : undefined}
    >
      <span className={styles.eyebrow}>
        {readOnly ? "Viewing as a customer (read-only)" : "Signed in as a customer"}
      </span>
      <span>
        <span className={styles.who}>{actingAs}</span>
        {role ? <span className={styles.muted}> · {role}</span> : null}
        {storeName ? <span className={styles.muted}> · {storeName}</span> : null}
      </span>
      <span className={styles.muted}>
        {readOnly
          ? "Every save is blocked on this session; nothing is written in their name."
          : `Everything you do here is recorded against them${byName ? ` with “via superadmin ${byName}”` : ""}.`}
      </span>
      <span className={styles.spacer} />
      <Button size="sm" tone="secondary" busy={busy} disabled={busy} onClick={() => { void exit(); }}>
        {readOnly ? "Exit view" : "Exit impersonation"}
      </Button>
    </div>
  );
}

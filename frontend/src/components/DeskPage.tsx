import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { activateCheckDevice, useCheckDevice, type CheckDevice } from "../api/checkCashing";
import {
  Alert, Button, Card, ConfirmDialog, ErrorState, Field, Input, Loading, SectionTitle,
} from "./ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { formatDateTime } from "../lib/datetime";
import { hasPermission } from "../lib/permissions";
import { useDeskScreen } from "../lib/useDeskScreen";
import styles from "./DeskPage.module.css";

// The page frame of the check cashing app (UI-STANDARDS §8 "Check
// cashing is a desk program"). It fills the window and never scrolls
// as a whole: fixed parts (crumbs, header, action bar) around boxes
// that scroll inside themselves. Check cashing runs only on a desktop
// and only on the store's activated computer
// (api/Modules/CheckCashing/INVARIANTS.md "One computer"): anywhere
// else the frame shows why, and lets a manager activate this one.

export function DeskPage({ children }: { children: ReactNode }) {
  const wide = useDeskScreen();
  const device = useCheckDevice();
  let body: ReactNode;
  if (!wide) body = <DesktopOnly />;
  else if (device.isError && !device.data) {
    body = (
      <DeviceError
        error={device.error}
        onRetry={() => void device.refetch()}
        busy={device.isFetching}
      />
    );
  } else if (!device.data) body = <Loading />;
  else if (device.data.state !== "this") body = <DeviceLock device={device.data} />;
  else body = children;
  return (
    <main className={`ds-page ${styles.page}`} data-desk-page>
      {body}
    </main>
  );
}

function DeviceError({ error, onRetry, busy }: { error: unknown; onRetry: () => void; busy: boolean }) {
  const t = useT();
  return (
    <ErrorState message={apiErrorMessage(error, t("checkCashing.loadFailed"))} onRetry={onRetry} busy={busy} />
  );
}

function DesktopOnly() {
  const t = useT();
  return (
    <Card className={styles.blocked}>
      <SectionTitle>{t("checkCashing.desktopOnlyTitle")}</SectionTitle>
      <p>{t("checkCashing.desktopOnly")}</p>
    </Card>
  );
}

/** This browser is not the store's check cashing computer. */
function DeviceLock({ device }: { device: CheckDevice }) {
  const t = useT();
  const queryClient = useQueryClient();
  const canManage = hasPermission("check_cashing_manage", "update");
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moving = device.state === "other";

  async function activate() {
    setBusy(true); setError(null);
    try {
      await activateCheckDevice(name.trim());
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.activateFailed")));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (moving) setConfirming(true);
    else void activate();
  }

  return (
    <Card className={styles.blocked}>
      <SectionTitle>
        {moving
          ? t("checkCashing.lockedTitle", { name: device.name })
          : t("checkCashing.notActivatedTitle")}
      </SectionTitle>
      <p>
        {moving
          ? t("checkCashing.lockedText", {
            name: device.name,
            when: device.last_seen_at ? formatDateTime(device.last_seen_at) : "—",
          })
          : t("checkCashing.notActivatedText")}
      </p>
      {canManage ? (
        <form onSubmit={onSubmit} className="ds-form">
          <Field label={t("checkCashing.computerName")} hint={t("checkCashing.computerNameHint")}>
            <Input
              type="text" maxLength={60} required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {error && !confirming && <Alert tone="error">{error}</Alert>}
          <div>
            <Button type="submit" busy={busy && !confirming} disabled={busy || !name.trim()}>
              {moving ? t("checkCashing.moveHere") : t("checkCashing.activateHere")}
            </Button>
          </div>
        </form>
      ) : (
        <p className={styles.note}>{t("checkCashing.askAdmin")}</p>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("checkCashing.moveTitle")}
        message={t("checkCashing.moveMessage", { old: device.name, name: name.trim() })}
        confirmLabel={t("checkCashing.moveHere")}
        busy={busy}
        error={error}
        onConfirm={() => { void activate(); }}
        onCancel={() => { setConfirming(false); setError(null); }}
      />
    </Card>
  );
}

/** A box that scrolls inside itself and takes the room that is left. */
export function DeskPane({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`${styles.pane} ${className ?? ""}`}>{children}</div>;
}

/** Side-by-side panes, each scrolling on its own. */
export function DeskColumns({ children }: { children: ReactNode }) {
  return <div className={styles.columns}>{children}</div>;
}

/** A form that passes the room down to its DeskPane and keeps its
 *  action bar (FormActions) at the bottom. */
export function DeskForm({
  children, onSubmit,
}: {
  children: ReactNode;
  onSubmit?: (e: FormEvent) => void;
}) {
  return <form onSubmit={onSubmit} className={`ds-form ${styles.fill}`}>{children}</form>;
}

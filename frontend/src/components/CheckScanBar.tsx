// How a check's numbers get onto Cash a check. In the Check Desk
// Windows app the scanner is the default, like the counter programs
// cashiers know: the page opens with "Scan check" ready, Enter (or a
// click) gets the Excella ready, and the moment a check goes in its
// MICR line fills the routing, account and check number and its
// pictures fill the two check slots. Without a scanner (a plain
// browser, or the scanner unplugged) the cashier types the MICR line
// and Enter fills the same boxes.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Scanner").

import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Input } from "./ui";
import { useT, type MessageKey } from "../i18n";
import { parseMicrLine, type MicrFields } from "../lib/micr";
import {
  cancelScan, inDesktopApp, scanCheck, ScanError, scannerStatus,
  type ScanErrorCode, type ScannerStatus,
} from "../lib/scanner";
import styles from "./CheckScanBar.module.css";

export interface ReadCheck extends MicrFields {
  /** The MICR line as read or typed, saved with the check. */
  raw: string;
}

const SCAN_ERRORS: Record<ScanErrorCode, MessageKey> = {
  not_connected: "checkCashing.scannerOff",
  no_check: "checkCashing.scanNoCheck",
  jam: "checkCashing.scanJam",
  busy: "checkCashing.scanBusy",
  failed: "checkCashing.scanFailed",
  no_app: "checkCashing.scannerOff",
};

type Note = { tone: "ok" | "warn"; key: MessageKey } | null;

/** The scan button (in the app, with a scanner) or the MICR line box.
 *  ``onRead`` gets the numbers; ``onPictures`` the scanner's base64
 *  pictures. ``resetKey`` changing (the form was cleared) puts the
 *  focus back, so the next check is one Enter away. */
export function CheckScanBar({
  onRead, onPictures, disabled, resetKey,
}: {
  onRead: (check: ReadCheck) => void;
  onPictures: (front: string | null, back: string | null) => Promise<void>;
  disabled?: boolean;
  resetKey?: number;
}) {
  const t = useT();
  const app = inDesktopApp();
  const [status, setStatus] = useState<ScannerStatus | "checking">(app ? "checking" : "not_connected");
  const [scanning, setScanning] = useState(false);
  const [line, setLine] = useState("");
  const [note, setNote] = useState<Note>(null);
  const box = useRef<HTMLSpanElement>(null);

  const recheck = useCallback(async () => {
    if (!app) return;
    setStatus("checking");
    setStatus(await scannerStatus());
  }, [app]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ask the app once when the page opens
    void recheck();
  }, [recheck]);

  const ready = app && status === "ready";

  // Back to the start after a clear: focus the scan button or the box.
  useEffect(() => {
    if (disabled) return;
    box.current?.querySelector<HTMLElement>("button[data-scan], input")?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a cleared form starts with no message
    setNote(null);
  }, [resetKey, ready, disabled]);

  const scan = useCallback(async () => {
    if (scanning || disabled) return;
    setScanning(true); setNote(null);
    try {
      const got = await scanCheck();
      const parsed = got.routing ? null : parseMicrLine(got.raw);
      const fields: MicrFields = parsed ?? {
        routing: got.routing, account: got.account, number: got.number,
        amountCents: got.amountCents,
        routingValid: true,
      };
      if (!fields.routing) {
        setNote({ tone: "warn", key: "checkCashing.scanFailed" });
        return;
      }
      onRead({ ...fields, raw: got.raw });
      setNote({ tone: "ok", key: "checkCashing.scanned" });
      if (got.front || got.back) {
        try {
          await onPictures(got.front, got.back);
        } catch {
          setNote({ tone: "warn", key: "checkCashing.scanPicturesFailed" });
        }
      }
    } catch (err) {
      const code = err instanceof ScanError ? err.code : "failed";
      if (code === "not_connected") setStatus("not_connected");
      setNote({ tone: "warn", key: SCAN_ERRORS[code] });
    } finally {
      setScanning(false);
    }
  }, [scanning, disabled, onRead, onPictures]);

  // Enter anywhere on the page (nothing else focused) scans, as in the
  // counter programs.
  useEffect(() => {
    if (!ready) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Enter" || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el && el !== document.body) return;
      e.preventDefault();
      void scan();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ready, scan]);

  function fill() {
    const fields = parseMicrLine(line);
    if (!fields) {
      setNote({ tone: "warn", key: "checkCashing.micrUnread" });
      return;
    }
    onRead({ ...fields, raw: line.trim() });
    setLine("");
    setNote(fields.routingValid
      ? { tone: "ok", key: "checkCashing.scanned" }
      : { tone: "warn", key: "checkCashing.micrBadRouting" });
  }

  return (
    <span className={styles.bar} ref={box}>
      {ready ? (
        scanning ? (
          <>
            <span className={styles.waiting} role="status">{t("checkCashing.scanWaiting")}</span>
            <Button type="button" tone="secondary" size="sm" onClick={cancelScan}>
              {t("checkCashing.scanStop")}
            </Button>
          </>
        ) : (
          <>
            {!note && <span className={styles.hint}>{t("checkCashing.scanHint")}</span>}
            <Button
              type="button" data-scan="" disabled={disabled}
              onClick={() => void scan()}
            >
              {t("checkCashing.scanCheck")}
            </Button>
          </>
        )
      ) : (
        <>
          {app && status === "not_connected" && !note && (
            <span className={styles.warn}>{t("checkCashing.scannerOff")}</span>
          )}
          {app && status === "not_connected" && (
            <Button type="button" tone="ghost" size="sm" disabled={disabled} onClick={() => void recheck()}>
              {t("checkCashing.scannerRetry")}
            </Button>
          )}
          <span className={styles.line}>
          <Input
            type="text" maxLength={120} className={styles.mono}
            aria-label={t("checkCashing.micrLine")}
            placeholder={t("checkCashing.micrPlaceholder")}
            title={t("checkCashing.micrHint")}
            disabled={disabled || status === "checking"}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); fill(); }
            }}
          />
          </span>
          <Button
            type="button" tone="secondary" size="sm"
            disabled={disabled || !line.trim()} onClick={fill}
          >
            {t("checkCashing.micrFill")}
          </Button>
        </>
      )}
      {note && (
        <span className={note.tone === "ok" ? styles.ok : styles.warn} role="status">
          {t(note.key)}
        </span>
      )}
    </span>
  );
}

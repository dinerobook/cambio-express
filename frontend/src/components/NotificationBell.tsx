import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  BELL_QUERY_KEY, useBell, useBellActions, type BellItem,
} from "../api/bell";
import { canAccess } from "../lib/access";
import { useT } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import { BELL_ITEMS, type BellIcon } from "../lib/bellItems";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { AppLink, Button, CountBadge, useToast } from "./ui";
import styles from "./NotificationBell.module.css";

// The top-bar notification bell (UI-STANDARDS §11). A fixed-size
// button whose count badge is drawn ON TOP of it, so nothing in the
// bar moves whether the count is 0 or 12. Clicking opens a short
// list; each row opens the page that fixes it, and Dismiss hides it
// until the store's next day.
//
// Built on Radix Popover (UI-STANDARDS §5): it owns Escape, outside
// click and focus return. The panel keeps the kit's `.ds-popover`
// fade, which honours reduced motion.

const HINT_KEY = "db.bell.enabled";

/** Was the bell on for this store last time? Lets the button take
 *  its place on first paint instead of popping in after the first
 *  answer and nudging its neighbours. Browser storage can be
 *  missing or blocked: then the bell simply appears once loaded. */
function readHint(storeId: number | null | undefined): boolean {
  if (storeId == null) return false;
  try {
    return window.localStorage.getItem(`${HINT_KEY}.${storeId}`) === "1";
  } catch {
    return false;
  }
}

function writeHint(storeId: number | null | undefined, on: boolean) {
  if (storeId == null) return;
  try {
    if (on) window.localStorage.setItem(`${HINT_KEY}.${storeId}`, "1");
    else window.localStorage.removeItem(`${HINT_KEY}.${storeId}`);
  } catch {
    // Storage blocked — only the first-paint hint is lost.
  }
}

export function NotificationBell() {
  const storeId = getCurrentIdentity()?.store_id;
  const bell = useBell();
  const { dismiss, undismiss } = useBellActions();
  const t = useT();
  const toast = useToast();
  const errorToast = useApiErrorToast();
  const qc = useQueryClient();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const data = bell.data;
  const enabled = data ? data.enabled : readHint(storeId);

  useEffect(() => {
    if (data) writeHint(storeId, data.enabled);
  }, [data, storeId]);

  // Coming back from the page that fixed something: re-read.
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: BELL_QUERY_KEY });
  }, [location.pathname, qc]);

  if (!enabled) return null;

  const storeDay = data?.store_day ?? "";
  // No access, no control: an item whose page this person cannot
  // open is not shown (the server checks too).
  const items = (data?.items ?? []).filter(
    (i) => canAccess(BELL_ITEMS[i.kind].to(i, { storeDay })),
  );
  const count = items.length;
  const label = count === 0
    ? t("bell.labelNone")
    : count === 1
      ? t("bell.labelOne")
      : t("bell.labelMany", { count });

  async function onDismiss(item: BellItem) {
    listRef.current?.focus();
    try {
      await dismiss(item);
    } catch (err) {
      errorToast(err, t("bell.dismissFailed"));
      return;
    }
    toast({
      tone: "info",
      message: t("bell.dismissed"),
      action: {
        label: t("bell.undo"),
        onClick: () => {
          undismiss(item).catch((err: unknown) => (
            errorToast(err, t("bell.undoFailed"))
          ));
        },
      },
    });
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void bell.refetch();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.bellBtn}
          aria-label={label}
          title={t("shell.notifications")}
          data-testid="notification-bell"
        >
          <BellGlyph />
          <CountBadge count={count} max={9} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={`${styles.panel} ds-popover`}
          align="end"
          side="bottom"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t("shell.notifications")}
        >
          <div className={styles.header}>
            <h2 className={styles.title}>{t("shell.notifications")}</h2>
          </div>
          <div
            className={styles.body}
            ref={listRef}
            tabIndex={-1}
          >
            {!data && bell.isError ? (
              <div className={styles.state}>
                <p>{t("bell.loadError")}</p>
                <Button
                  tone="secondary" size="sm"
                  onClick={() => void bell.refetch()}
                >
                  {t("bell.retry")}
                </Button>
              </div>
            ) : !data ? (
              <div className={styles.state} aria-busy="true">{t("common.loading")}</div>
            ) : count === 0 ? (
              <div className={styles.state}>
                <span className={styles.caughtUpIcon} aria-hidden="true">
                  <ItemIcon icon="done" />
                </span>
                <p>{t("bell.caughtUp")}</p>
              </div>
            ) : (
              <ul className={styles.list}>
                {items.map((item) => {
                  const spec = BELL_ITEMS[item.kind];
                  const ctx = { storeDay };
                  const title = spec.title(item, ctx);
                  return (
                    <li key={item.key} className={styles.row}>
                      <AppLink
                        to={spec.to(item, ctx)}
                        className={styles.rowLink}
                        onClick={() => setOpen(false)}
                      >
                        <span
                          className={`${styles.icon} ${item.urgency === "overdue" ? styles.overdue : styles.due}`}
                          aria-hidden="true"
                        >
                          <ItemIcon icon={spec.icon} />
                        </span>
                        <span className={styles.text}>
                          <span className={styles.rowTitle}>{title}</span>
                          <span className={styles.rowDetail}>
                            {spec.detail(item, ctx)}
                          </span>
                        </span>
                      </AppLink>
                      {data.can_dismiss && (
                        <button
                          type="button"
                          className={styles.dismissBtn}
                          aria-label={t("bell.dismissLabel", { title })}
                          title={t("bell.dismissTitle")}
                          onClick={() => void onDismiss(item)}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                            strokeLinejoin="round" aria-hidden="true">
                            <path d="M18 6 6 18" />
                            <path d="m6 6 12 12" />
                          </svg>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <p className={styles.footer}>
            {t("bell.footer")}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BellGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function ItemIcon({ icon }: { icon: BellIcon | "done" }) {
  const common = {
    width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (icon) {
    case "book":
      return (
        <svg {...common}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" />
          <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
        </svg>
      );
    case "cash":
      return (
        <svg {...common}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <circle cx="12" cy="12" r="2.5" />
        </svg>
      );
    case "bank":
      return (
        <svg {...common}>
          <path d="M3 10 12 4l9 6" />
          <path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8" />
          <path d="M3 21h18" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M6 10h6M6 14h9" />
        </svg>
      );
    case "done":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12 3 3 5-6" />
        </svg>
      );
  }
}

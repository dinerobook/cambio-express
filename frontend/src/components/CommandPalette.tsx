import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";

import { useSessionStatus } from "../api/account";
import { getCurrentIdentity } from "../lib/auth";
import { CHECK_HOME, filterNavForRole } from "./navConfig";
import { checksAvailable } from "../lib/workspace";
import styles from "./CommandPalette.module.css";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

/** The key cap, printed as on the keyboard in every language. */
const ESC_KEY = "esc";

interface CommandItem {
  label: string;
  to: string;
  group: string;
  keywords?: string;
}

function buildItems(
  role: string, permissions: string[] = [], features?: string[],
): CommandItem[] {
  const groups = filterNavForRole(role, permissions, features);
  const items: CommandItem[] = [];
  // Check cashing is its own app (navConfig "Workspaces"); its pages
  // are searchable from either view, grouped under the app's name.
  if (checksAvailable(role, permissions, features)) {
    const app = navWord("Check cashing");
    for (const g of filterNavForRole(role, permissions, features, "checks")) {
      if (!g.to) continue;
      items.push({
        label: g.to === CHECK_HOME ? app : `${app}: ${navWord(g.title)}`,
        to: g.to,
        group: app,
        keywords: `check cashing ${app} ${g.title} ${navWord(g.title)}`.toLowerCase(),
      });
    }
  }
  for (const g of groups) {
    // Direct-link group (e.g. Reports): the group itself is the
    // destination, so add it as its own command entry.
    if (g.to) {
      // Shown in the person's language; the English stays in the
      // search words so either finds the page.
      items.push({
        label: navWord(g.title),
        to: g.to,
        group: navWord(g.title),
        keywords: `${g.title} ${navWord(g.title)}`.toLowerCase(),
      });
    }
    for (const item of g.items) {
      items.push({
        label: navWord(item.label),
        to: item.to,
        group: navWord(g.title),
        keywords: [g.title, item.label, navWord(g.title), navWord(item.label)]
          .join(" ").toLowerCase(),
      });
    }
  }
  return items;
}

export function CommandPalette() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const identity = getCurrentIdentity();
  const { data: sessionStatus } = useSessionStatus();
  const items = identity
    ? buildItems(identity.role, identity.permissions, sessionStatus?.features)
    : [];

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function go(to: string) {
    setOpen(false);
    navigate(to);
  }

  if (!open) return null;

  const grouped = new Map<string, CommandItem[]>();
  for (const item of items) {
    const arr = grouped.get(item.group) ?? [];
    arr.push(item);
    grouped.set(item.group, arr);
  }

  return (
    <div className={styles.overlay} onClick={() => setOpen(false)}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <Command label={t("palette.label")}>
          <Command.Input
            className={styles.input}
            placeholder={t("palette.placeholder")}
            autoFocus
          />
          <Command.List className={styles.list}>
            <Command.Empty className={styles.empty}>
              {t("palette.empty")}
            </Command.Empty>
            {Array.from(grouped.entries()).map(([group, groupItems]) => (
              <Command.Group key={group} heading={group} className={styles.groupHeading}>
                {groupItems.map((item) => (
                  <Command.Item
                    key={item.to}
                    value={item.keywords}
                    onSelect={() => go(item.to)}
                    className={styles.item}
                  >
                    <span className={styles.itemIcon}>→</span>
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className={styles.footer}>
            <span>
              <span className={styles.kbd}>↑↓</span> {t("palette.navigate")}
              <span className={styles.kbd}>↵</span> {t("palette.open")}
              <span className={styles.kbd}>{ESC_KEY}</span> {t("palette.close")}
            </span>
            <span>
              <span className={styles.kbd}>⌘K</span> {t("palette.toggle")}
            </span>
          </div>
        </Command>
      </div>
    </div>
  );
}

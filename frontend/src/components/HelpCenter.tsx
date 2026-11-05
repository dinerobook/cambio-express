import { useEffect, useMemo, useRef, useState } from "react";

import { HELP_REGISTRY, type HelpEntry } from "../lib/help/registry";
import { searchHelp } from "../lib/help/search";
import styles from "./HelpCenter.module.css";
import { AppLink, Empty } from "./ui";
import { useT } from "../i18n";


/** Floating help bubble + searchable answer panel.
 *
 *  Mounted once by ``AppShell`` so every authenticated route
 *  has the bubble in the bottom-right.  Click → opens the
 *  panel.  Backdrop click, ESC, or the × button closes.
 *
 *  Registry + search live in ``frontend/src/lib/help/`` — the
 *  bubble is purely UI.  Adding a new Q&A entry is a one-file
 *  edit; no plumbing changes here.
 *
 *  v2 (LLM fallback) will add a "ask Claude" button below the
 *  result list when the empty-handed branch fires.  This v1
 *  ships the surface + the registry so muscle memory builds
 *  before we wire the model.
 */
export function HelpCenter() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ESC closes; click-outside is handled by the backdrop button.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the search box when the panel opens.  Setting state
  // synchronously inside the effect gates on ``open`` so we
  // only run when the panel just appeared.
  useEffect(() => {
    if (open) {
      // Wait one frame so the input is mounted.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const results = useMemo<HelpEntry[]>(
    () => searchHelp(query, HELP_REGISTRY),
    [query],
  );

  return (
    <>
      <button
        type="button"
        className={styles.bubble}
        onClick={() => setOpen(true)}
        aria-label={t("help.title")}
        title={t("help.title")}
      >
        ?
      </button>

      {open && (
        <div
          className={styles.backdrop}
          onMouseDown={(e) => {
            // Click on the backdrop (outside the panel) closes.
            // Comparing identity instead of stopPropagation keeps
            // the markup free of an interactive parent wrapping
            // interactive children (which fails a11y rules).
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("help.center")}
            className={styles.panel}
          >
            <div className={styles.panelHeader}>
              <span className={styles.panelTitle}>{t("help.title")}</span>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => setOpen(false)}
                aria-label={t("common.close")}
              >
                ×
              </button>
            </div>

            <div className={styles.searchRow}>
              <input
                ref={inputRef}
                type="search"
                className={styles.searchInput}
                placeholder={t("help.placeholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className={styles.results}>
              {results.length === 0 && (
                <Empty>
                  {t("help.noMatches")}
                </Empty>
              )}
              {results.map((entry) => (
                <AnswerCard
                  key={entry.title}
                  entry={entry}
                  onClose={() => setOpen(false)}
                />
              ))}
            </div>

            <div className={styles.footer}>
              {t("help.footer")}
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function AnswerCard({
  entry, onClose,
}: { entry: HelpEntry; onClose: () => void }) {
  return (
    <div className={styles.answer}>
      <div className={styles.answerTitle}>{entry.title}</div>
      <div
        className={styles.answerBody}
        // Authored constant strings only — see ``registry.ts``
        // for the allowed tag list.  No user input flows here,
        // so the dangerouslySetInnerHTML is safe.
        dangerouslySetInnerHTML={{ __html: entry.body }}
      />
      {entry.deepLink && (
        <AppLink
          to={entry.deepLink.to}
          className={styles.deepLink}
          onClick={onClose}
        >
          {entry.deepLink.label} →
        </AppLink>
      )}
    </div>
  );
}

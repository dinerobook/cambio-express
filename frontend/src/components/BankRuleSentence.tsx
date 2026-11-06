import { conditionChips, postOffsetLabel } from "../lib/bankRules";
import { Pill } from "./ui";
import styles from "./BankRuleSentence.module.css";
import { useT } from "../i18n";

/** "If <conditions> → Categorize as <target>" — a store rule (the
 *  rules page) or a rule template (the rules page's Templates card
 *  and the superadmin's templates page), as the sentence it reads
 *  as. */
export function BankRuleSentence({
  rule, target, off = false,
}: {
  rule: { auto_post?: boolean; post_date_offset_days?: number }
    & Parameters<typeof conditionChips>[0];
  /** The category's label as the reader knows it. */
  target: string;
  /** Show the "off" pill (a disabled rule, a hidden template). */
  off?: boolean;
}) {
  const t = useT();
  return (
    <>
      <div className={styles.clauseRow}>
        <span className={styles.kw}>{t("ruleSentence.if")}</span>
        {conditionChips(rule).map((c, j) => (
          <span key={j} className={styles.chipGroup}>
            {j > 0 && <span className={styles.kw}>{t("ruleSentence.and")}</span>}
            {c.map((word, k) => (
              <span key={k} className={styles.chip}>{word}</span>
            ))}
          </span>
        ))}
      </div>
      <div className={styles.clauseRow}>
        <span className={styles.arrow} aria-hidden>→</span>
        <span className={styles.kw}>{t("ruleSentence.categorizeAs")}</span>
        <span className={`${styles.chip} ${styles.chipTarget}`}>{target}</span>
        {rule.auto_post && (
          <Pill tone="accent">{t("ruleSentence.books")}</Pill>
        )}
        {rule.auto_post && !!rule.post_date_offset_days && (
          <Pill tone="neutral">
            {postOffsetLabel(rule.post_date_offset_days)}
          </Pill>
        )}
        {off && <Pill tone="neutral">{t("ruleSentence.off")}</Pill>}
      </div>
    </>
  );
}

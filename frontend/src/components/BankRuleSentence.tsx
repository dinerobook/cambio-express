import { conditionChips, postOffsetLabel } from "../lib/bankRules";
import { Pill } from "./ui";
import styles from "./BankRuleSentence.module.css";

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
  return (
    <>
      <div className={styles.clauseRow}>
        <span className={styles.kw}>If</span>
        {conditionChips(rule).map((c, j) => (
          <span key={j} className={styles.chipGroup}>
            {j > 0 && <span className={styles.kw}>and</span>}
            {c.map((t, k) => (
              <span key={k} className={styles.chip}>{t}</span>
            ))}
          </span>
        ))}
      </div>
      <div className={styles.clauseRow}>
        <span className={styles.arrow} aria-hidden>→</span>
        <span className={styles.kw}>Categorize as</span>
        <span className={`${styles.chip} ${styles.chipTarget}`}>{target}</span>
        {rule.auto_post && (
          <Pill tone="accent">books on daily book</Pill>
        )}
        {rule.auto_post && !!rule.post_date_offset_days && (
          <Pill tone="neutral">
            {postOffsetLabel(rule.post_date_offset_days)}
          </Pill>
        )}
        {off && <Pill tone="neutral">off</Pill>}
      </div>
    </>
  );
}

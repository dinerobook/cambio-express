import type { ReactNode } from "react";

import type { BankRuleTemplateRow } from "../api/bankSync";
import { BankRuleSentence } from "./BankRuleSentence";
import styles from "./BankRuleTemplateList.module.css";

/** The rule templates as a list of sentences under their names —
 *  the store's Templates card on the rules page ("Use") and the
 *  superadmin's templates page (Edit / Delete). `action` renders
 *  the right-hand control for one row. */
export function BankRuleTemplateList({
  rows, action,
}: {
  rows: BankRuleTemplateRow[];
  action: (t: BankRuleTemplateRow) => ReactNode;
}) {
  return (
    <ul className={styles.list}>
      {rows.map((t) => (
        <li key={t.id} className={[styles.row, t.enabled ? "" : styles.off].join(" ")}>
          <div className={styles.body}>
            <span className={styles.name}>{t.name}</span>
            <BankRuleSentence
              rule={t} target={t.target_label || t.target_kind} off={!t.enabled}
            />
          </div>
          <div className={styles.action}>{action(t)}</div>
        </li>
      ))}
    </ul>
  );
}

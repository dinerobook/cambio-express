import { useQueryClient } from "@tanstack/react-query";

import type { BankTransactionRow } from "../api/bankSync";
import { BankRuleForm } from "./BankRuleForm";
import { Modal, useToast } from "./ui";
import { describeAppliedRule } from "../lib/bankRules";
import { suggestRuleFor } from "../lib/bankRuleSuggest";
import { tNodes, useT } from "../i18n";
import styles from "./BankRuleFromRow.module.css";

/** The fields a rule is suggested from. */
export type RuleSourceRow = Pick<
  BankTransactionRow, "id" | "description" | "amount_cents" | "category_slug"
>;

/** "Make a rule" / "Do this every time" from one bank row: the shared
 *  rule form in a popup, prefilled from the row (its description and
 *  its category). One copy for the Bank transactions page and the
 *  Monthly P&L's Transactions tab. Saving applies the rule to the
 *  rows already there; every bank query refreshes. */
export function BankRuleFromRow({
  row, onClose,
}: {
  row: RuleSourceRow | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  return (
    <Modal
      open={row != null}
      onClose={onClose}
      title={t("bankTxn.ruleTitle")}
      size="lg"
    >
      {row && (
        <>
          <p className={styles.modalLead}>
            {tNodes("bankTxn.ruleLead", {
              desc: <strong>{row.description || t("bankTxn.this")}</strong>,
            })}
          </p>
          <BankRuleForm
            key={row.id}
            initial={{
              ...suggestRuleFor(row),
              target_kind: row.category_slug,
              account_filter_id: "",
            }}
            onCancel={onClose}
            onSaved={(resp) => {
              onClose();
              toast({
                message: `${t("bankTxn.ruleCreated")}${describeAppliedRule(resp.applied)}`,
                tone: "success",
              });
              void qc.invalidateQueries({ queryKey: ["bank"] });
              void qc.invalidateQueries({ queryKey: ["monthly"] });
            }}
          />
        </>
      )}
    </Modal>
  );
}

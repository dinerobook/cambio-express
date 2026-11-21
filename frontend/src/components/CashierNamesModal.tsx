import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { saveCashierNames, useCashiers } from "../api/posimport";
import {
  Alert, Button, ErrorState, Input, Loading, Modal, ModalActions, Table,
  useToast,
} from "./ui";
import { fmtNumber } from "../lib/formatters";
import { formatDate } from "../lib/datetime";
import { apiErrorMessage } from "../lib/api";
import { useT } from "../i18n";
import styles from "./CashierNamesModal.module.css";

/** Name the register's cashier numbers (Transactions → Cashier
 *  names). Passport's journal says only "cashier 91"; who that is
 *  lives in the register's own setup, which never reaches us, so the
 *  store types it once here and every ticket shows the name. A blank
 *  name forgets one. A form in a `<Modal>`, so no unsaved-changes
 *  guard (UI-STANDARDS §2): closing it is explicit. */
export function CashierNamesModal({
  open, onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const cashiers = useCashiers(open);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from what is saved each time the popup opens.
  useEffect(() => {
    if (!open || !cashiers.data) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the form from the loaded names when the popup opens
    setNames(Object.fromEntries(cashiers.data.rows.map((r) => [r.cashier_id, r.name])));
    setError(null);
  }, [open, cashiers.data]);

  const rows = cashiers.data?.rows ?? [];
  const changed = rows.filter((r) => (names[r.cashier_id] ?? "").trim() !== r.name);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await saveCashierNames(changed.map((r) => ({
        cashier_id: r.cashier_id, name: (names[r.cashier_id] ?? "").trim(),
      })));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["posimport", "cashiers"] }),
        qc.invalidateQueries({ queryKey: ["posimport", "transactions"] }),
        qc.invalidateQueries({ queryKey: ["posimport", "transaction"] }),
      ]);
      toast({ message: t("posTx.namesSaved"), tone: "success" });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, t("posTx.namesFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("posTx.cashierNames")}
      size="lg"
      disabled={busy}
      actions={
        <ModalActions>
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => { void onSave(); }} busy={busy} disabled={changed.length === 0}>
            {t("common.save")}
          </Button>
        </ModalActions>
      }
    >
      <p className={styles.intro}>{t("posTx.namesIntro")}</p>
      {error && <Alert tone="error">{error}</Alert>}
      {cashiers.isLoading && <Loading />}
      {cashiers.isError && (
        <ErrorState
          message={t("posTx.namesLoadFailed")}
          onRetry={() => { void cashiers.refetch(); }}
        />
      )}
      {cashiers.data && rows.length === 0 && (
        <p className={styles.intro}>{t("posTx.namesEmpty")}</p>
      )}
      {rows.length > 0 && (
        <Table>
          <thead>
            <tr>
              <th>{t("posTx.colCashierNumber")}</th>
              <th>{t("posTx.colName")}</th>
              <th className={styles.num}>{t("posTx.tickets")}</th>
              <th>{t("posTx.colLastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cashier_id}>
                <td className={styles.mono}>#{r.cashier_id}</td>
                <td>
                  <Input
                    aria-label={t("posTx.nameFor", { id: r.cashier_id })}
                    value={names[r.cashier_id] ?? ""}
                    maxLength={80}
                    placeholder={t("posTx.namePlaceholder")}
                    onChange={(e) => setNames((n) => ({ ...n, [r.cashier_id]: e.target.value }))}
                  />
                </td>
                <td className={`${styles.num} ${styles.mono}`}>{fmtNumber(r.ticket_count)}</td>
                <td>{r.last_seen ? formatDate(r.last_seen) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Modal>
  );
}

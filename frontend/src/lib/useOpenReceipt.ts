import { useNavigate, useSearchParams } from "react-router-dom";

import styles from "../components/ReceiptPanel.module.css";

// The receipt opens beside a Transactions list from this width;
// narrower, a row opens the ticket's own page (UI-STANDARDS §7
// "Register receipts").
export const SIDE_PANEL_MIN_WIDTH = 1100;

function roomForPanel(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(`(min-width: ${SIDE_PANEL_MIN_WIDTH}px)`).matches;
}

/** Which ticket's receipt is open beside a Transactions list
 *  (`<ReceiptSplit>`). It rides in the URL as `ticket`, beside the
 *  list's filters, but choosing one keeps the page the list is on (a
 *  filter change would reset it). */
export function useOpenReceipt() {
  const navigate = useNavigate();
  const [sp, setSP] = useSearchParams();
  const selected = Number(sp.get("ticket")) || null;
  const set = (id: number | null) => {
    const next = new URLSearchParams(sp);
    if (id) next.set("ticket", String(id));
    else next.delete("ticket");
    setSP(next, { replace: true });
  };
  return {
    selected,
    /** Beside the list when the window has room, else its own page. */
    open: (id: number) => (roomForPanel() ? set(id) : navigate(`/transactions/${id}`)),
    close: () => set(null),
    /** The class that marks the rows of the open ticket. */
    rowClass: (id: number) => (id === selected ? styles.selectedRow : undefined),
  };
}

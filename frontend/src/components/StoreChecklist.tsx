import { Button, Checkbox } from "./ui";
import { useT } from "../i18n";
import type { useStoreSelection } from "../lib/useStoreSelection";
import styles from "./StoreChecklist.module.css";

/** The owner bulk tools' "Apply to" list: Select all / Clear all, the
 *  "N of M selected" count and one checkbox per store. Add user to
 *  stores, Cross-store defaults and Bulk permissions each had their
 *  own copy (one without the count); the selection itself is
 *  `useStoreSelection`. */
export function StoreChecklist({
  stores, selection,
}: {
  stores: ReadonlyArray<{ store_id: number; store_name: string; store_slug?: string }>;
  selection: ReturnType<typeof useStoreSelection>;
}) {
  const t = useT();
  return (
    <>
      <div className={styles.toolbar}>
        <Button type="button" tone="secondary" size="sm" onClick={selection.toggleAll}>
          {selection.allSelected ? t("bulkAdd.clearAll") : t("bulkAdd.selectAll")}
        </Button>
        <span className={styles.count}>
          {t("bulkAdd.selectedOf", { count: selection.selected.length, total: stores.length })}
        </span>
      </div>
      <ul className={styles.list}>
        {stores.map((s) => (
          <li key={s.store_id}>
            <Checkbox
              checked={selection.isSelected(s.store_id)}
              onChange={() => selection.toggle(s.store_id)}
              style={{ alignItems: "center", width: "100%" }}
            >
              <span className={styles.name}>{s.store_name}</span>{" "}
              {s.store_slug && <span className={styles.slug}>{s.store_slug}</span>}
            </Checkbox>
          </li>
        ))}
      </ul>
    </>
  );
}

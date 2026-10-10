import { useCallback, useState } from "react";

/** The "apply to these stores" picker state behind every owner bulk
 *  action: a set of selected store ids, a per-store toggle, and a
 *  Select all / Clear all switch over `allIds`.
 *
 *  `selected` keeps click order (the order the request sends).
 *  `allSelected` is false for an empty umbrella, so the switch reads
 *  "Select all" rather than offering to clear nothing. */
export function useStoreSelection(allIds: readonly number[]) {
  const [selected, setSelected] = useState<number[]>([]);

  const allSelected = allIds.length > 0
    && allIds.every((id) => selected.includes(id));

  const toggle = useCallback((id: number) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }, []);

  function toggleAll() {
    setSelected(allSelected ? [] : [...allIds]);
  }

  const clear = useCallback(() => setSelected([]), []);

  return {
    selected,
    isSelected: (id: number) => selected.includes(id),
    toggle,
    toggleAll,
    clear,
    allSelected,
  };
}

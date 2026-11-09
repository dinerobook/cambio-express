import { useEffect, useState } from "react";

/** `value`, once it has stopped changing for `ms` (300 ms, the
 *  app's live-search pause). For a request fired as the person
 *  types that does not live in the URL (useUrlFilterState covers
 *  list pages). */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

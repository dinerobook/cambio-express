import { useEffect, useState } from "react";

/** Narrowest window the check cashing app runs in (desktop only,
 *  UI-STANDARDS §8). */
export const DESK_MIN_WIDTH = 1024;

function wideEnough(): boolean {
  // No matchMedia (tests, old browsers): treat as a desktop; the
  // server-side computer lock is the real gate.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(`(min-width: ${DESK_MIN_WIDTH}px)`).matches;
}

/** True while the window is wide enough for check cashing. */
export function useDeskScreen(): boolean {
  const [wide, setWide] = useState(wideEnough);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(min-width: ${DESK_MIN_WIDTH}px)`);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return wide;
}

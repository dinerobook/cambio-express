import type { PermMatrix } from "../api/roles";

// Starting points for a new access role. These used to be presets
// on each person's login form; they live here now so "HR &
// payroll" is something you create once as a role and give to
// people, instead of a grid copied onto each of them.

export function emptyMatrix(
  resources: string[], actions: string[],
): PermMatrix {
  const m: PermMatrix = {};
  for (const r of resources) {
    m[r] = {};
    for (const a of actions) m[r][a] = false;
  }
  return m;
}

/** HR & payroll: run the time clock, see the roster — nothing else. */
export function hrMatrix(resources: string[], actions: string[]): PermMatrix {
  const m = emptyMatrix(resources, actions);
  if (m.time_clock) for (const a of actions) m.time_clock[a] = true;
  if (m.users) m.users.read = true;
  return m;
}

/** Bookkeeper: view every ledger, move no money, change nothing. */
export function bookkeeperMatrix(
  resources: string[], actions: string[],
): PermMatrix {
  const m = emptyMatrix(resources, actions);
  for (const r of resources) {
    if (r === "settings" || r === "users") continue;
    if (m[r]) m[r].read = true;
  }
  return m;
}

/** How many areas a matrix grants anything on — the "7 of 14"
 *  shown wherever a role is summarized instead of drawn. */
export function areasGranted(matrix: PermMatrix | undefined): number {
  if (!matrix) return 0;
  return Object.values(matrix).filter(
    (row) => Object.values(row ?? {}).some(Boolean),
  ).length;
}

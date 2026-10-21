import { roleLabel, roleTone } from "../api/roles";
import { Pill } from "./ui";

/** A built-in role as a pill: one tone and one name per role on
 *  every screen (UI-STANDARDS §3 and §7b). */
export function RolePill({ role }: { role: string }) {
  return <Pill tone={roleTone(role)}>{roleLabel(role)}</Pill>;
}

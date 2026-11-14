import { RETURN_CHECK_STATUS_TONES, returnCheckStatusLabel } from "../api/returnChecks";
import { Pill } from "./ui";

/** A returned check's status as a pill (UI-STANDARDS §3 tones) —
 *  the check list and a batch's check list. */
export function ReturnCheckStatusPill({ status }: { status: string }) {
  const tone = RETURN_CHECK_STATUS_TONES[status] ?? "neutral";
  return <Pill tone={tone}>{returnCheckStatusLabel(status)}</Pill>;
}

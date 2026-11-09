import type { MessageKey } from "../i18n";

/** The status tabs over the check customers and companies lists. */
export const STATUS_TABS: Array<{ slug: string; label: MessageKey }> = [
  { slug: "",        label: "checkCashing.all" },
  { slug: "normal",  label: "checkCashing.statusNormal" },
  { slug: "trusted", label: "checkCashing.statusTrusted" },
  { slug: "blocked", label: "checkCashing.statusBlocked" },
];

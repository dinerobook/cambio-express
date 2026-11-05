import { t, type MessageKey } from "../i18n";

/** The target / action filter options the store audit feed supports,
 *  one list so the admin Audit log page and the superadmin store
 *  page's Activity section offer the same vocabulary. Labels are
 *  message keys: read them through `t()` during render. */
export const AUDIT_TARGET_OPTIONS: ReadonlyArray<{ value: string; label: MessageKey }> = [
  { value: "", label: "audit.all" },
  { value: "transfer", label: "audit.targetTransfer" },
  { value: "daily_report", label: "audit.targetDailyReport" },
  { value: "batch", label: "audit.targetBatch" },
];

export const AUDIT_ACTION_OPTIONS: ReadonlyArray<{ value: string; label: MessageKey }> = [
  { value: "", label: "audit.all" },
  { value: "create", label: "audit.actCreate" },
  { value: "update", label: "audit.actUpdate" },
  { value: "delete", label: "audit.actDelete" },
  { value: "lock", label: "audit.actLock" },
  { value: "unlock", label: "audit.actUnlock" },
  { value: "status_changed", label: "audit.actStatusChanged" },
];

const ACTION_KEYS: Record<string, MessageKey> = {
  create: "audit.actCreate",
  created: "audit.actCreated",
  update: "audit.actUpdate",
  updated: "audit.actUpdated",
  delete: "audit.actDelete",
  deleted: "audit.actDeleted",
  lock: "audit.actLock",
  unlock: "audit.actUnlock",
  status_changed: "audit.actStatusChanged",
};

const TARGET_KEYS: Record<string, MessageKey> = {
  transfer: "audit.targetTransfer",
  daily_report: "audit.targetDailyReport",
  batch: "audit.targetBatch",
};

/** An audit row's action slug in the reader's language. A slug the
 *  list doesn't know (a newer server) shows as sent. */
export function auditActionLabel(action: string): string {
  const key = Object.hasOwn(ACTION_KEYS, action) ? ACTION_KEYS[action] : undefined;
  return key ? t(key) : action;
}

/** An audit row's target type in the reader's language; unknown
 *  types show as sent. */
export function auditTargetLabel(target: string): string {
  const key = Object.hasOwn(TARGET_KEYS, target) ? TARGET_KEYS[target] : undefined;
  return key ? t(key) : target;
}

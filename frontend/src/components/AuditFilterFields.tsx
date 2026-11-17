import { Field, Select } from "./ui";
import { AUDIT_ACTION_OPTIONS, AUDIT_TARGET_OPTIONS } from "./auditFilters";
import { useT } from "../i18n";

/** The Target and Action pickers over an audit feed: the store's Audit
 *  log, a person's own Activity and the superadmin store page's
 *  Activity section all filter with these two (three hand copies
 *  before, with two Spanish words for "Target"). A page adds its own
 *  extra fields (the Audit log's User) beside them. */
export function AuditFilterFields({
  target, action, onTarget, onAction, targetAria, actionAria,
}: {
  target: string;
  action: string;
  onTarget: (value: string) => void;
  onAction: (value: string) => void;
  /** A fuller accessible name when the page holds more than one list. */
  targetAria?: string;
  actionAria?: string;
}) {
  const t = useT();
  return (
    <>
      <Field label={t("audit.target")} style={{ minWidth: "10rem" }}>
        <Select aria-label={targetAria} value={target} onChange={(e) => onTarget(e.target.value)}>
          {AUDIT_TARGET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.label)}</option>
          ))}
        </Select>
      </Field>
      <Field label={t("audit.action")} style={{ minWidth: "10rem" }}>
        <Select aria-label={actionAria} value={action} onChange={(e) => onAction(e.target.value)}>
          {AUDIT_ACTION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.label)}</option>
          ))}
        </Select>
      </Field>
    </>
  );
}

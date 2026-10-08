/** The target / action filter options the store audit feed supports,
 *  one list so the admin Audit log page and the superadmin store
 *  page's Activity section offer the same vocabulary. */
export const AUDIT_TARGET_OPTIONS = [
  { value: "", label: "All" },
  { value: "transfer", label: "Transfer" },
  { value: "daily_report", label: "Daily Report" },
  { value: "batch", label: "ACH Batch" },
];

export const AUDIT_ACTION_OPTIONS = [
  { value: "", label: "All" },
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "delete", label: "Delete" },
  { value: "lock", label: "Lock" },
  { value: "unlock", label: "Unlock" },
  { value: "status_changed", label: "Status changed" },
];

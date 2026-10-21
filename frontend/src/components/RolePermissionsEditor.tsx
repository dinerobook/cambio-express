import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

import { api, apiErrorMessage } from "../lib/api";
import { roleLabel, type PermMatrix } from "../api/roles";
import { actionsFor, toggleMatrixCell } from "../lib/permissions";
import { fmtCount } from "../lib/formatters";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import {
  Alert, Button, Card, Checkbox, ConfirmDialog, ErrorState, FormActions,
  Loading, SectionTitle, useToast,
} from "./ui";
import { PermissionMatrixTable } from "./PermissionMatrixTable";
import { RolePill } from "./RolePill";
import styles from "./RolePermissionsEditor.module.css";

/** What every role-matrix endpoint answers: the platform defaults
 *  (`/superadmin/permissions`) and one store's grid (owner and
 *  superadmin `…/store/{id}/permissions`). */
export interface RoleMatrixResponse {
  roles: string[];
  resources: string[];
  actions: string[];
  matrix: Record<string, PermMatrix>;
  /** Roles this caller may change. Absent: every role. */
  editable_roles?: string[];
  /** Roles this store has changed from the platform defaults.
   *  Present only on a store's grid, where "Reset to defaults"
   *  (`POST {endpoint}/reset`) puts a role back. */
  has_overrides?: string[];
}

/** The one editor for a set of roles' permission grids. Every
 *  page that edits role permissions renders this (UI-STANDARDS §6):
 *  the same grouped grid with an "All" column, the same
 *  unsaved-changes bar, the same save (only the roles that changed,
 *  each in full — the server replaces a role it is sent and leaves
 *  the rest alone) and the same confirmed reset. */
export function RolePermissionsEditor({
  endpoint, queryKey, enabled = true, hideLockedRoles = false, intro,
}: {
  /** GET loads the grid, PUT `{matrix}` saves it. */
  endpoint: string;
  queryKey: QueryKey;
  enabled?: boolean;
  /** Leave out the roles the caller cannot change instead of
   *  showing them locked. */
  hideLockedRoles?: boolean;
  /** Shown above the grids once they load. */
  intro?: ReactNode;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useQuery<RoleMatrixResponse>({
    enabled,
    queryKey,
    queryFn: () => api<RoleMatrixResponse>(endpoint),
  });
  const [draft, setDraft] = useState<RoleMatrixResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(structuredClone(data)); // eslint-disable-line react-hooks/set-state-in-effect -- hydrate the editable draft from the server grid
  }, [data]);

  const changedCells = (role: string): number => {
    if (!data || !draft) return 0;
    let n = 0;
    for (const resource of draft.resources) {
      for (const action of draft.actions) {
        if (Boolean(data.matrix[role]?.[resource]?.[action])
          !== Boolean(draft.matrix[role]?.[resource]?.[action])) n += 1;
      }
    }
    return n;
  };
  const changed = draft ? draft.roles.reduce((n, r) => n + changedCells(r), 0) : 0;
  const isDirty = changed > 0;
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: "You have permission changes that are not saved. Leave without saving?",
  });

  const canEdit = (role: string) =>
    !draft?.editable_roles || draft.editable_roles.includes(role);

  function update(role: string, resource: string, fn: (row: Record<string, boolean>) => Record<string, boolean>) {
    if (!canEdit(role)) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      next.matrix[role][resource] = fn(next.matrix[role][resource] ?? {});
      return next;
    });
  }

  function loaded(result: RoleMatrixResponse) {
    setDraft(structuredClone(result));
    qc.setQueryData(queryKey, result);
  }

  async function save() {
    if (!draft || !isDirty) return;
    const matrix: Record<string, PermMatrix> = {};
    for (const role of draft.roles) {
      if (canEdit(role) && changedCells(role) > 0) matrix[role] = draft.matrix[role];
    }
    setBusy(true);
    setSaveError(null);
    try {
      loaded(await api<RoleMatrixResponse>(endpoint, { method: "PUT", json: { matrix } }));
      toast({ message: `${fmtCount(changed, "permission")} updated.`, tone: "success" });
    } catch (err) {
      setSaveError(apiErrorMessage(err, "Could not save permissions."));
    } finally {
      setBusy(false);
    }
  }

  async function resetRole(role: string) {
    setBusy(true);
    setResetError(null);
    try {
      loaded(await api<RoleMatrixResponse>(`${endpoint}/reset`, { method: "POST", json: { role } }));
      setResetting(null);
      toast({ message: `${roleLabel(role)} permissions reset to the defaults.`, tone: "success" });
    } catch (err) {
      setResetError(apiErrorMessage(err, "Could not reset permissions."));
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <ErrorState
        message={apiErrorMessage(error, "Could not load permissions.")}
        onRetry={() => { void refetch(); }}
      />
    );
  }
  if (!draft) return null;

  const roles = hideLockedRoles ? draft.roles.filter(canEdit) : draft.roles;

  return (
    <>
      {intro}
      {saveError && <Alert tone="error">{saveError}</Alert>}

      {roles.map((role) => {
        const editable = canEdit(role);
        const customized = draft.has_overrides?.includes(role) ?? false;
        return (
          <Card key={role}>
            <div className={styles.roleHead}>
              <SectionTitle>
                <RolePill role={role} />
                {customized && <span className={styles.customized}>Customized</span>}
                {!editable && <span className={styles.locked}>View only</span>}
              </SectionTitle>
              {editable && customized && (
                <Button
                  tone="secondary" size="sm" disabled={busy}
                  onClick={() => { setResetError(null); setResetting(role); }}
                >
                  Reset to defaults
                </Button>
              )}
            </div>
            <PermissionMatrixTable
              grouped
              resources={draft.resources}
              actions={draft.actions}
              checked={(resource, action) => Boolean(draft.matrix[role]?.[resource]?.[action])}
              onToggle={(resource, action) =>
                update(role, resource, (row) => toggleMatrixCell(row, action, resource))}
              disabled={!editable}
              ariaContext={role}
              trailingColumn={{
                header: "All",
                render: (resource) => {
                  const all = actionsFor(resource, draft.actions).every(
                    (a) => draft.matrix[role]?.[resource]?.[a],
                  );
                  return (
                    <Checkbox
                      checked={all}
                      disabled={!editable}
                      onChange={() => update(role, resource, (row) => {
                        const next = { ...row };
                        for (const a of actionsFor(resource, draft.actions)) next[a] = !all;
                        return next;
                      })}
                      aria-label={`All actions — ${resource} (${role})`}
                    />
                  );
                },
              }}
            />
          </Card>
        );
      })}

      <FormActions guard={guard}>
        <Button
          tone="secondary"
          onClick={() => { if (data) setDraft(structuredClone(data)); }}
          disabled={!isDirty || busy}
        >
          Discard changes
        </Button>
        <Button onClick={() => { void save(); }} busy={busy} disabled={!isDirty || busy}>
          Save permissions
        </Button>
      </FormActions>

      <ConfirmDialog
        open={resetting != null}
        title={`Reset ${roleLabel(resetting ?? "").toLowerCase()} permissions?`}
        message="This role's changes here are replaced with the platform defaults. People with this role are signed out and pick up the defaults when they sign back in."
        confirmLabel="Reset to defaults"
        confirmTone="danger"
        busy={busy}
        error={resetError}
        onConfirm={() => { if (resetting) void resetRole(resetting); }}
        onCancel={() => setResetting(null)}
      />
    </>
  );
}

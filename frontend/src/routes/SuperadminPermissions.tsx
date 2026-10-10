import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError, apiErrorMessage } from "../lib/api";
import { roleTone } from "../api/roles";
import { actionsFor, toggleMatrixCell } from "../lib/permissions";
import { getCurrentIdentity } from "../lib/auth";
import { useUnsavedChangesGuard } from "../lib/useUnsavedChangesGuard";
import {
  Alert,
  Breadcrumbs,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Loading,
  PageHeader,
  PageShell,
  Pill,
  SectionTitle,
  useToast,
} from "../components/ui";
import { PermissionMatrixTable } from "../components/PermissionMatrixTable";
import styles from "./SuperadminPermissions.module.css";

interface PermissionMatrix {
  roles: string[];
  resources: string[];
  actions: string[];
  matrix: Record<string, Record<string, Record<string, boolean>>>;
}

function usePermissionMatrix() {
  const identity = getCurrentIdentity();
  return useQuery<PermissionMatrix>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "permissions"],
    queryFn: () => api<PermissionMatrix>("/api/v2/superadmin/permissions"),
  });
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
  owner: "Owner",
};

export default function SuperadminPermissions() {
  const { data, isLoading, isError, error, refetch } = usePermissionMatrix();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<PermissionMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local draft from server-fetched matrix for controlled checkboxes
      setDraft(structuredClone(data));
    }
  }, [data]);

  const isDirty = data && draft
    ? JSON.stringify(data.matrix) !== JSON.stringify(draft.matrix)
    : false;
  // Warn on tab-close / refresh while the permission matrix has unsaved
  // toggles (the page saves in place — no navigating Cancel to guard).
  useUnsavedChangesGuard(isDirty);

  function toggle(role: string, resource: string, action: string) {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      next.matrix[role][resource] = toggleMatrixCell(next.matrix[role][resource], action, resource);
      return next;
    });
  }

  function toggleAllForRole(role: string, resource: string, value: boolean) {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      for (const action of actionsFor(resource, next.actions)) {
        next.matrix[role][resource][action] = value;
      }
      return next;
    });
  }

  function reset() {
    if (data) setDraft(structuredClone(data));
  }

  async function save() {
    if (!data || !draft) return;
    setBusy(true);
    setSaveError(null);
    // The server replaces a role's whole grid, so send only the
    // roles that changed, each in full.
    const matrix: PermissionMatrix["matrix"] = {};
    let changed = 0;
    for (const role of draft.roles) {
      let roleChanged = false;
      for (const resource of draft.resources) {
        for (const action of draft.actions) {
          if (data.matrix[role][resource][action] !== draft.matrix[role][resource][action]) {
            roleChanged = true;
            changed += 1;
          }
        }
      }
      if (roleChanged) matrix[role] = draft.matrix[role];
    }
    if (changed === 0) return;
    try {
      const result = await api<PermissionMatrix>("/api/v2/superadmin/permissions", {
        method: "PUT",
        json: { matrix },
      });
      setDraft(structuredClone(result));
      qc.setQueryData(["superadmin", "permissions"], result);
      toast({ message: `${changed} permission${changed === 1 ? "" : "s"} updated.`, tone: "success" });
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save permissions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell gap="1.25rem">
      <Breadcrumbs crumbs={[{ label: "Platform" }, { label: "Permissions" }]} />

      <PageHeader
        title="Role Permissions"
        subtitle="Configure what each role can do across the platform"
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={apiErrorMessage(error, "Could not load permissions")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {saveError && <Alert tone="error">{saveError}</Alert>}

      {draft && draft.roles.map((role) => (
        <Card key={role}>
          <SectionTitle>
            <Pill tone={roleTone(role)}>{ROLE_LABELS[role] ?? role}</Pill>
          </SectionTitle>
          <PermissionMatrixTable
            resources={draft.resources}
            actions={draft.actions}
            checked={(resource, action) => draft.matrix[role][resource][action]}
            onToggle={(resource, action) => toggle(role, resource, action)}
            ariaContext={role}
            trailingColumn={{
              header: "All",
              render: (resource) => {
                const allChecked = actionsFor(resource, draft.actions).every(
                  (a) => draft.matrix[role][resource][a],
                );
                return (
                  <Checkbox
                    checked={allChecked}
                    onChange={() => toggleAllForRole(role, resource, !allChecked)}
                    aria-label={`All actions — ${resource} (${role})`}
                  />
                );
              },
            }}
          />
        </Card>
      ))}

      {draft && (
        <div className={styles.saveBar}>
          {isDirty && (
            <span className={styles.dirty}>Unsaved changes</span>
          )}
          <Button tone="secondary" onClick={reset} disabled={!isDirty || busy}>
            Reset
          </Button>
          <Button onClick={() => { void save(); }} busy={busy} disabled={!isDirty || busy}>
            {busy ? "Saving…" : "Save permissions"}
          </Button>
        </div>
      )}
    </PageShell>
  );
}

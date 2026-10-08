import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminUserPermissions, useAdminUsers } from "../api/admin";
import {
  assignAccessRole, createAccessRole, fetchRoleMembers, resetBuiltinRole,
  saveBuiltinRole, updateAccessRole, useAccessRoles, useBuiltinRoles,
  type PermMatrix,
} from "../api/roles";
import { ApiError } from "../lib/api";
import { refreshToken } from "../lib/auth";
import { hasPermission, toggleMatrixCell } from "../lib/permissions";
import {
  bookkeeperMatrix, emptyMatrix, hrMatrix,
} from "../lib/roleTemplates";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import { PermissionMatrixTable } from "../components/PermissionMatrixTable";
import {
  Alert, Breadcrumbs, Button, Card, ConfirmDialog, ErrorState, Field,
  Input, Loading, PageHeader, PageShell, Select, useToast,
} from "../components/ui";
import styles from "./RoleEdit.module.css";

// One role, on its own page (Team → Roles & access → a role).
//
// `:roleId` is one of:
//   - "new"                — a new saved role. `?copy=<id|employee|
//     admin>` seeds it from another role, `?from_user=<uid>` from a
//     person's custom access (and puts that person in it on save).
//   - a number             — a saved role. Editing it changes what
//     its members can do RIGHT NOW, so the confirmation names them.
//   - "employee" / "admin" — a built-in role: the store's defaults
//     for that account type. A store admin may edit Employee only.

const BUILTIN_NAMES: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
};

type Template = "blank" | "employee" | "hr" | "bookkeeper";

export default function RoleEdit() {
  const { roleId = "new" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const isNew = roleId === "new";
  const builtinKey = roleId in BUILTIN_NAMES ? roleId : null;
  const savedId = !isNew && !builtinKey ? Number(roleId) : null;
  const copyFrom = isNew ? params.get("copy") : null;
  const fromUser = isNew ? Number(params.get("from_user")) || null : null;

  const saved = useAccessRoles();
  const builtin = useBuiltinRoles(hasPermission("settings", "read"));
  const users = useAdminUsers();
  const userPerms = useAdminUserPermissions(fromUser);
  const members = useQuery({
    enabled: savedId != null,
    queryKey: ["admin", "roles", savedId, "members"],
    queryFn: () => fetchRoleMembers(savedId as number),
  });

  const resources = saved.data?.resources ?? builtin.data?.resources ?? [];
  const actions = saved.data?.actions ?? builtin.data?.actions ?? [];
  const savedRole = savedId != null
    ? saved.data?.roles.find((r) => r.id === savedId) ?? null
    : null;
  const fromUserRow = fromUser != null
    ? users.data?.rows.find((u) => u.id === fromUser) ?? null
    : null;
  const canEditBuiltin = builtinKey != null
    && (builtin.data?.editable_roles.includes(builtinKey) ?? false);
  const readOnly = builtinKey != null && !canEditBuiltin;

  /** Where this page's matrix starts — null until the data it
   *  needs has loaded. */
  function initial(): { name: string; matrix: PermMatrix } | null {
    if (savedId != null) {
      return savedRole
        ? { name: savedRole.name, matrix: structuredClone(savedRole.matrix) }
        : null;
    }
    if (builtinKey) {
      const m = builtin.data?.matrix[builtinKey];
      return m
        ? { name: BUILTIN_NAMES[builtinKey], matrix: structuredClone(m) }
        : null;
    }
    if (fromUser != null) {
      return userPerms.data
        ? { name: "", matrix: structuredClone(userPerms.data.matrix) }
        : null;
    }
    if (copyFrom) {
      const src = copyFrom in BUILTIN_NAMES
        ? builtin.data?.matrix[copyFrom]
        : saved.data?.roles.find((r) => r.id === Number(copyFrom))?.matrix;
      const srcName = copyFrom in BUILTIN_NAMES
        ? BUILTIN_NAMES[copyFrom]
        : saved.data?.roles.find((r) => r.id === Number(copyFrom))?.name;
      return src
        ? { name: `Copy of ${srcName ?? "role"}`, matrix: structuredClone(src) }
        : null;
    }
    return resources.length
      ? { name: "", matrix: emptyMatrix(resources, actions) }
      : null;
  }

  const [draft, setDraft] = useState<{ name: string; matrix: PermMatrix } | null>(null);
  const [baseline, setBaseline] = useState<string>("");
  const [template, setTemplate] = useState<Template>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-null once we've asked the server who this edit would hit.
  const [pending, setPending] = useState<string[] | null>(null);

  const start = initial();
  const startKey = start ? JSON.stringify(start) : "";
  useEffect(() => {
    if (draft != null || !startKey) return;
    const s = JSON.parse(startKey) as { name: string; matrix: PermMatrix };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable draft once the role (or its source) has loaded
    setDraft(s);
    setBaseline(startKey);
  }, [draft, startKey]);

  const isDirty = draft != null && JSON.stringify(draft) !== baseline;
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: "You have unsaved changes to this role. Leave without saving?",
  });

  function backToList() {
    navigate("/team/roles");
  }

  function applyTemplate(t: Template) {
    setTemplate(t);
    let matrix: PermMatrix;
    if (t === "hr") matrix = hrMatrix(resources, actions);
    else if (t === "bookkeeper") matrix = bookkeeperMatrix(resources, actions);
    else if (t === "employee" && builtin.data?.matrix.employee) {
      matrix = structuredClone(builtin.data.matrix.employee);
    } else matrix = emptyMatrix(resources, actions);
    setDraft((d) => (d ? { ...d, matrix } : d));
  }

  function toggle(resource: string, action: string) {
    setDraft((d) => {
      if (!d) return d;
      const matrix = structuredClone(d.matrix);
      matrix[resource] = toggleMatrixCell(matrix[resource], action);
      return { ...d, matrix };
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (builtinKey) {
        const result = await saveBuiltinRole(builtinKey, draft.matrix);
        qc.setQueryData(["store-permissions"], result);
        await refreshToken();
        toast({
          message: `${BUILTIN_NAMES[builtinKey]} role saved.`,
          tone: "success",
        });
      } else if (savedId != null) {
        const res = await updateAccessRole(savedId, {
          name: draft.name, matrix: draft.matrix,
        });
        const n = res.affected_members?.length ?? 0;
        toast({
          message: n
            ? `Saved. Access updated for ${n} ${n === 1 ? "person" : "people"}.`
            : "Saved.",
          tone: "success",
        });
      } else {
        const role = await createAccessRole({
          name: draft.name, matrix: draft.matrix,
        });
        if (fromUser != null) {
          // Same matrix they already have, so their access does
          // not change; they just follow the role from now on.
          await assignAccessRole(fromUser, role.id);
        }
        toast({
          message: fromUserRow
            ? `Role created. ${fromUserRow.full_name || fromUserRow.username} now follows it.`
            : "Role created.",
          tone: "success",
        });
      }
      void qc.invalidateQueries({ queryKey: ["admin", "roles"] });
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      setBaseline(JSON.stringify(draft));
      backToList();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // A new role has no members, and neither does an empty one —
    // go straight through rather than confirming nothing.
    if (savedId == null || !savedRole || savedRole.member_count === 0) {
      void save();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetchRoleMembers(savedId);
      setPending(res.members.map((m) => m.name));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message : "Could not check who this affects.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resetToDefaults() {
    if (!builtinKey) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resetBuiltinRole(builtinKey);
      qc.setQueryData(["store-permissions"], result);
      await refreshToken();
      const m = structuredClone(result.matrix[builtinKey]);
      const next = { name: BUILTIN_NAMES[builtinKey], matrix: m };
      setDraft(next);
      setBaseline(JSON.stringify(next));
      toast({
        message: `${BUILTIN_NAMES[builtinKey]} role reset to the DineroBook defaults.`,
        tone: "success",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reset.");
    } finally {
      setBusy(false);
    }
  }

  const title = builtinKey
    ? BUILTIN_NAMES[builtinKey]
    : savedRole?.name ?? (isNew ? "New role" : "Role");

  // Who is in this role, for the side panel.
  const memberNames: string[] = savedId != null
    ? (members.data?.members ?? []).map((m) => m.name)
    : builtinKey
    ? (users.data?.rows ?? [])
        .filter((u) => u.is_active && u.role === builtinKey
          && u.store_role_id == null && !u.has_custom_permissions)
        .map((u) => u.full_name || u.username)
    : fromUserRow
    ? [fromUserRow.full_name || fromUserRow.username]
    : [];

  const loadFailed = (savedId != null && saved.isSuccess && !savedRole)
    || saved.isError;

  return (
    <PageShell gap="1.25rem">
      <Breadcrumbs crumbs={[
        { label: "Team" },
        { label: "Roles & access", to: "/team/roles" },
        { label: title },
      ]} />
      <PageHeader title={title} />

      {loadFailed && (
        <ErrorState
          message="Could not load this role."
          onRetry={() => { void saved.refetch(); }}
        />
      )}
      {!loadFailed && !draft && <Loading />}

      {draft && (
        <form onSubmit={onSubmit} className={styles.layout}>
          <Card>
            <div className={styles.grid}>
              {error && <Alert tone="error">{error}</Alert>}
              {readOnly && (
                <Alert tone="info">
                  Admins can do everything in the store. This role is
                  shown for reference and can't be changed here.
                </Alert>
              )}
              <PermissionMatrixTable
                resources={resources}
                actions={actions}
                checked={(r, a) => draft.matrix[r]?.[a] ?? false}
                onToggle={toggle}
                disabled={busy || readOnly}
                resourceHeader="Area"
                ariaContext={title}
                grouped
              />
            </div>
          </Card>

          <aside className={styles.side}>
            <Card>
              <div className={styles.grid}>
                {builtinKey ? (
                  <Field
                    label="Role"
                    hint={`Everyone with a${builtinKey === "admin" ? "n Admin" : "n Employee"} login who isn't in another role follows this one.`}
                  >
                    <Input type="text" value={title} disabled />
                  </Field>
                ) : (
                  <Field
                    label="Role name"
                    hint="What this job is called in your store, like “Shift lead” or “Bookkeeper”."
                  >
                    <Input
                      type="text" value={draft.name} required maxLength={60}
                      placeholder="Shift lead"
                      onChange={(e) => {
                        const name = e.target.value;
                        setDraft((d) => (d ? { ...d, name } : d));
                      }}
                      disabled={busy}
                    />
                  </Field>
                )}

                {isNew && !copyFrom && fromUser == null && (
                  <Field label="Start from">
                    <Select
                      value={template}
                      onChange={(e) => applyTemplate(e.target.value as Template)}
                      disabled={busy}
                    >
                      <option value="blank">Nothing ticked</option>
                      {builtin.data?.matrix.employee && (
                        <option value="employee">The Employee role</option>
                      )}
                      <option value="hr">HR &amp; payroll: time clock only, no financials</option>
                      <option value="bookkeeper">Bookkeeper: view the books, move no money</option>
                    </Select>
                  </Field>
                )}

                <div>
                  <div className={styles.label}>
                    {fromUser != null ? "Will follow this role" : "In this role"}
                  </div>
                  {memberNames.length === 0 ? (
                    <p className={styles.muted}>Nobody yet.</p>
                  ) : (
                    <ul className={styles.members}>
                      {memberNames.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </div>

                {!readOnly && memberNames.length > 0 && fromUser == null && (
                  <p className={styles.muted}>
                    Saving changes what{" "}
                    {memberNames.length === 1 ? "this person" : `these ${memberNames.length} people`}
                    {" "}can do right away.
                  </p>
                )}

                {!readOnly && (
                  <div className={styles.actions}>
                    <Button
                      tone="secondary" type="button"
                      onClick={() => guard.confirmLeave(backToList)}
                      disabled={busy}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit" busy={busy}
                      disabled={busy || (!isNew && !isDirty)}
                    >
                      {isNew ? "Create role" : "Save role"}
                    </Button>
                  </div>
                )}
                {builtinKey && canEditBuiltin
                  && builtin.data?.has_overrides.includes(builtinKey) && (
                  <Button
                    tone="secondary" size="sm" type="button"
                    onClick={() => { void resetToDefaults(); }}
                    disabled={busy}
                  >
                    Reset to DineroBook defaults
                  </Button>
                )}
              </div>
            </Card>
          </aside>
        </form>
      )}

      <ConfirmDialog
        open={pending != null}
        title="This changes people's access"
        message={
          pending && pending.length
            ? `Saving updates access for ${pending.length} `
              + `${pending.length === 1 ? "person" : "people"}: `
              + `${pending.join(", ")}. `
              + "They'll be signed out so the change takes effect."
            : "Saving updates this role."
        }
        confirmLabel="Save and update them"
        busy={busy}
        onConfirm={() => { void save(); }}
        onCancel={() => setPending(null)}
      />
      <ConfirmDialog {...guard.dialogProps} />
    </PageShell>
  );
}

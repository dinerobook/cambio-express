import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAdminUserPermissions, useAdminUsers } from "../api/admin";
import {
  assignAccessRole, createAccessRole, fetchRoleMembers, resetBuiltinRole,
  saveBuiltinRole, updateAccessRole, useAccessRoles, useBuiltinRoles,
  type PermMatrix, roleLabel,
} from "../api/roles";
import { apiErrorMessage } from "../lib/api";
import { refreshToken } from "../lib/auth";
import { hasPermission, toggleMatrixCell } from "../lib/permissions";
import {
  bookkeeperMatrix, emptyMatrix, hrMatrix,
} from "../lib/roleTemplates";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import { PermissionMatrixTable } from "../components/PermissionMatrixTable";
import {
  Alert, Button, Card, ConfirmDialog, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, Select, useToast,
} from "../components/ui";
import styles from "./RoleEdit.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { t, tn, useT } from "../i18n";

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

// The built-in roles a store edits here, named once in api/roles
// (at render, so the name follows the language).
const BUILTIN_ROLES = ["admin", "employee"];
const isBuiltin = (key: string | null): key is string =>
  key != null && BUILTIN_ROLES.includes(key);

type Template = "blank" | "employee" | "hr" | "bookkeeper";

export default function RoleEdit() {
  const { roleId = "new" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  useT(); // re-render on a language switch

  const isNew = roleId === "new";
  const builtinKey = isBuiltin(roleId) ? roleId : null;
  const savedId = !isNew && !builtinKey ? Number(roleId) : null;
  const copyFrom = isNew ? params.get("copy") : null;
  const fromUser = isNew ? Number(params.get("from_user")) || null : null;

  // A built-in role (or a new role copied from one) is read from the
  // store-permissions route, which needs settings.read.
  const needsBuiltin = builtinKey != null
    || isBuiltin(copyFrom);
  const canReadBuiltin = hasPermission("settings", "read");

  const saved = useAccessRoles();
  const builtin = useBuiltinRoles(canReadBuiltin);
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
  // A built-in row saves through the store-permissions route
  // (Settings: edit); a saved role through the roles route (Team:
  // edit). Someone who holds neither sees the grid, not a form the
  // server would refuse.
  const canEditBuiltin = builtinKey != null
    && (builtin.data?.editable_roles.includes(builtinKey) ?? false)
    && hasPermission("settings", "update");
  const readOnly = builtinKey != null
    ? !canEditBuiltin
    : !hasPermission("users", "update");

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
        ? { name: roleLabel(builtinKey), matrix: structuredClone(m) }
        : null;
    }
    if (fromUser != null) {
      return userPerms.data
        ? { name: "", matrix: structuredClone(userPerms.data.matrix) }
        : null;
    }
    if (copyFrom) {
      const src = isBuiltin(copyFrom)
        ? builtin.data?.matrix[copyFrom]
        : saved.data?.roles.find((r) => r.id === Number(copyFrom))?.matrix;
      const srcName = isBuiltin(copyFrom)
        ? roleLabel(copyFrom)
        : saved.data?.roles.find((r) => r.id === Number(copyFrom))?.name;
      return src
        ? { name: t("roleEdit.copyOf", { name: srcName ?? t("roleEdit.role") }), matrix: structuredClone(src) }
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
    message: t("roleEdit.unsavedMessage"),
  });

  function backToList() {
    navigate("/team/roles");
  }

  function applyTemplate(tpl: Template) {
    setTemplate(tpl);
    let matrix: PermMatrix;
    if (tpl === "hr") matrix = hrMatrix(resources, actions);
    else if (tpl === "bookkeeper") matrix = bookkeeperMatrix(resources, actions);
    else if (tpl === "employee" && builtin.data?.matrix.employee) {
      matrix = structuredClone(builtin.data.matrix.employee);
    } else matrix = emptyMatrix(resources, actions);
    setDraft((d) => (d ? { ...d, matrix } : d));
  }

  function toggle(resource: string, action: string) {
    setDraft((d) => {
      if (!d) return d;
      const matrix = structuredClone(d.matrix);
      matrix[resource] = toggleMatrixCell(matrix[resource], action, resource);
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
          message: t("roleEdit.builtinSaved", { name: roleLabel(builtinKey) }),
          tone: "success",
        });
      } else if (savedId != null) {
        const res = await updateAccessRole(savedId, {
          name: draft.name, matrix: draft.matrix,
        });
        const n = res.affected_members?.length ?? 0;
        toast({
          message: n
            ? tn("roleEdit.savedFor", n, fmtNumber)
            : t("roleEdit.saved"),
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
            ? t("roleEdit.createdFollows", { name: fromUserRow.full_name || fromUserRow.username })
            : t("roleEdit.created"),
          tone: "success",
        });
      }
      void qc.invalidateQueries({ queryKey: ["admin", "roles"] });
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      setBaseline(JSON.stringify(draft));
      guard.proceed(backToList);
    } catch (err) {
      setError(apiErrorMessage(err, t("roleEdit.saveFailed")));
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
        apiErrorMessage(err, t("roleEdit.checkFailed")),
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
      const next = { name: roleLabel(builtinKey), matrix: m };
      setDraft(next);
      setBaseline(JSON.stringify(next));
      toast({
        message: t("roleEdit.resetDone", { name: roleLabel(builtinKey) }),
        tone: "success",
      });
    } catch (err) {
      setError(apiErrorMessage(err, t("roleEdit.resetFailed")));
    } finally {
      setBusy(false);
    }
  }

  const title = builtinKey
    ? roleLabel(builtinKey)
    : savedRole?.name ?? (isNew ? t("roleEdit.newRole") : t("roleEdit.roleTitle"));

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

  const builtinDenied = needsBuiltin && !canReadBuiltin;
  const loadFailed = (savedId != null && saved.isSuccess && !savedRole)
    || saved.isError
    || (needsBuiltin && builtin.isError);

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs current={title} />
      <PageHeader title={title} />

      {builtinDenied ? (
        <ErrorState message={t("roleEdit.noBuiltinAccess")} />
      ) : loadFailed ? (
        <ErrorState
          message={t("roleEdit.loadFailed")}
          onRetry={() => {
            if (saved.isError) void saved.refetch();
            if (builtin.isError) void builtin.refetch();
          }}
        />
      ) : !draft && <Loading />}

      {draft && (
        <form onSubmit={onSubmit} className={styles.layout}>
          <Card>
            <div className={styles.grid}>
              {error && <Alert tone="error">{error}</Alert>}
              {readOnly && (
                <Alert tone="info">
                  {builtinKey === "admin"
                    ? t("roleEdit.adminReadOnly")
                    : t("roleEdit.readOnly")}
                </Alert>
              )}
              <PermissionMatrixTable
                resources={resources}
                actions={actions}
                checked={(r, a) => draft.matrix[r]?.[a] ?? false}
                onToggle={toggle}
                disabled={busy || readOnly}
                resourceHeader={t("userForm.area")}
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
                    label={t("roleEdit.roleTitle")}
                    hint={builtinKey === "admin" ? t("roleEdit.adminFollows") : t("roleEdit.employeeFollows")}
                  >
                    <Input type="text" value={title} disabled />
                  </Field>
                ) : (
                  <Field
                    label={t("roleEdit.name")}
                    hint={t("roleEdit.nameHint")}
                  >
                    <Input
                      type="text" value={draft.name} required maxLength={60}
                      placeholder={t("roleEdit.namePlaceholder")}
                      onChange={(e) => {
                        const name = e.target.value;
                        setDraft((d) => (d ? { ...d, name } : d));
                      }}
                      disabled={busy}
                    />
                  </Field>
                )}

                {isNew && !copyFrom && fromUser == null && (
                  <Field label={t("roleEdit.startFrom")}>
                    <Select
                      value={template}
                      onChange={(e) => applyTemplate(e.target.value as Template)}
                      disabled={busy}
                    >
                      <option value="blank">{t("roleEdit.tplBlank")}</option>
                      {builtin.data?.matrix.employee && (
                        <option value="employee">{t("roleEdit.tplEmployee")}</option>
                      )}
                      <option value="hr">{t("roleEdit.tplHr")}</option>
                      <option value="bookkeeper">{t("roleEdit.tplBookkeeper")}</option>
                    </Select>
                  </Field>
                )}

                <div>
                  <div className={styles.label}>
                    {fromUser != null ? t("roleEdit.willFollow") : t("roleEdit.inRole")}
                  </div>
                  {memberNames.length === 0 ? (
                    <p className={styles.muted}>{t("roleEdit.nobody")}</p>
                  ) : (
                    <ul className={styles.members}>
                      {memberNames.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                </div>

                {!readOnly && memberNames.length > 0 && fromUser == null && (
                  <p className={styles.muted}>
                    {tn("roleEdit.savingChanges", memberNames.length, fmtNumber)}
                  </p>
                )}

                {!readOnly && (
                  <FormActions guard={guard}>
                    <Button
                      tone="secondary" type="button"
                      onClick={() => guard.confirmLeave(backToList)}
                      disabled={busy}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      type="submit" busy={busy}
                      disabled={busy || (!isNew && !isDirty)}
                    >
                      {isNew ? t("roleEdit.create") : t("roleEdit.save")}
                    </Button>
                  </FormActions>
                )}
                {builtinKey && canEditBuiltin
                  && builtin.data?.has_overrides.includes(builtinKey) && (
                  <Button
                    tone="secondary" size="sm" type="button"
                    onClick={() => { void resetToDefaults(); }}
                    disabled={busy}
                  >
                    {t("roleEdit.reset")}
                  </Button>
                )}
              </div>
            </Card>
          </aside>
        </form>
      )}

      <ConfirmDialog
        open={pending != null}
        title={t("roleEdit.confirmTitle")}
        message={
          pending && pending.length
            ? tn("roleEdit.confirmBody", pending.length, fmtNumber, { names: pending.join(", ") })
            : t("roleEdit.confirmNobody")
        }
        confirmLabel={t("roleEdit.confirmSave")}
        busy={busy}
        onConfirm={() => { void save(); }}
        onCancel={() => setPending(null)}
      />
    </PageShell>
  );
}

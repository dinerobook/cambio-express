import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  clearAdminUserPermissions, createAdminUser, setAdminUserPermissions,
  updateAdminUser, useAdminUser, useAdminUserPermissions, useAdminUsers,
  type AdminUserCreateBody, type AdminUserUpdateBody, type PermMatrix,
} from "../api/admin";
import { useSessionStatus } from "../api/account";
import { ApiError, apiErrorMessage } from "../lib/api";
import { hasPermission, toggleMatrixCell } from "../lib/permissions";
import { modulesOffForGrants } from "../lib/access";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Button, Card, Checkbox, ErrorState, Field,
  FormActions, Input, Loading, PageHeader, PageShell, Select, space,
  useToast,
} from "../components/ui";
import { PermissionMatrixTable } from "../components/PermissionMatrixTable";
import {
  assignAccessRole, roleLabel, useAccessRoles, useBuiltinRoles,
} from "../api/roles";
import { areasGranted, emptyMatrix } from "../lib/roleTemplates";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./AdminUserForm.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tNodes, useT, type MessageKey } from "../i18n";

// What this person can do — ONE picker. "role" = no overlay: they
// follow the built-in role of their account type. `saved:<id>` =
// one of the store's saved roles. "custom" = a grid for this one
// person. Roles themselves are built and edited on Team → Roles &
// access; this form only picks one, so it stays short however many
// areas the product grows (the grid only renders for "custom").
type AccessMode = "role" | "custom" | `saved:${number}`;

function savedRoleId(mode: AccessMode): number | null {
  return mode.startsWith("saved:")
    ? Number(mode.slice("saved:".length)) : null;
}

interface UserDraft {
  // Identity. New logins are created with email and/or phone (L-2);
  // `username` is the stored identifier, shown read-only on edit and
  // never typed by hand.
  username:  string;
  email:     string;
  phone:     string;
  full_name: string;
  role:      string;
  is_active: boolean;
  password:  string;
  // U-3 per-user module grants: restrict=false → all store
  // modules (module_access null); restrict=true → only `modules`.
  restrict:  boolean;
  modules:   string[];
  // R-1/R-2 custom access: access="role" → no overlay; anything
  // else carries the resource×action matrix in `perm`.
  access:    AccessMode;
  perm:      PermMatrix | null;
}

function makeBlankUser(): UserDraft {
  return {
    username: "", email: "", phone: "",
    full_name: "", role: "employee", is_active: true,
    password: "", restrict: false, modules: [],
    access: "role", perm: null,
  };
}

// Fallbacks only while the live lists load — the permission
// endpoints return the authoritative resources/actions.
const FALLBACK_RESOURCES = [
  "transfers", "customers", "daily_book", "monthly", "batches",
  "bank_sync", "reports", "settings", "users", "time_clock",
  "return_checks", "lottery", "day_close", "catalog",
];
const FALLBACK_ACTIONS = ["create", "read", "update", "delete"];

// Human labels for the store-module flags (keys mirror the
// backend's MODULE_FLAG_KEYS; the checkbox list only renders keys
// present in the store's session-status `features`). Values are
// translator keys; an unknown flag shows as stored.
const MODULE_LABELS: Record<string, MessageKey> = {
  module_money_services: "userForm.moduleMoneyServices",
  module_lottery:        "userForm.moduleLottery",
  module_day_close:      "userForm.moduleDayClose",
  module_check_cashing:  "userForm.moduleCheckCashing",
  module_price_book:     "userForm.modulePriceBook",
};

// /app/admin/users/new and /app/admin/users/:uid/edit — combined
// create + edit form. Mirrors the legacy admin_user_form.html
// surface 1:1 (username on create only, password optional on
// edit, role pick, is_active checkbox on edit). Field-level
// errors come back as 422 with `field_errors` (mirroring the
// Settings profile-tab pattern).

export default function AdminUserForm() {
  const { uid: uidStr } = useParams();
  // ?employee=<id> — arrived from the Employees hub's "Create a
  // login for this employee": link the new account to that HR
  // record on success and return to the employee form (E-2).
  const [searchParams] = useSearchParams();
  const linkEmployeeId =
    Number(searchParams.get("employee")) || null;
  const uid = uidStr ? Number(uidStr) : null;
  const isEdit = uid != null;

  const queryClient = useQueryClient();
  const navigate    = useNavigate();
  const toast = useToast();
  const t = useT();
  const identity    = getCurrentIdentity();
  const moduleLabel = (flag: string) =>
    Object.hasOwn(MODULE_LABELS, flag) ? t(MODULE_LABELS[flag]) : flag;

  const detail  = useAdminUser(isEdit ? uid : null);
  // The roster carries which account types the viewer may hand
  // out (rank rule) — the picker never offers one the server
  // would refuse.
  const roster  = useAdminUsers();
  const assignableRoles = roster.data?.assignable_roles ?? ["admin", "employee"];
  const session = useSessionStatus();
  const userPerms = useAdminUserPermissions(isEdit ? uid : null);
  const accessRoles = useAccessRoles();
  // Built-in role matrices seed the "Custom" editor on create and
  // feed the "N of M areas" summary under the picker.
  // The endpoint needs settings.read; ask by permission, not by
  // account type (a custom role can hold users.* without it).
  const storePerms = useBuiltinRoles(hasPermission("settings", "read"));

  // Form state — three sources hydrate it: the detail response on
  // edit, blank defaults on create.
  const [draft, setDraft] = useState<UserDraft>(makeBlankUser);
  // Baseline = last server-synced (or blank) draft; drives the guard.
  const [baseline, setBaseline] = useState<UserDraft>(makeBlankUser);
  const [busy, setBusy]   = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const u = detail.data.user;
    const fields = {
      username:  u.username,
      full_name: u.full_name,
      role:      u.role || "employee",
      is_active: u.is_active,
      password:  "",
      restrict:  u.module_access != null,
      modules:   u.module_access ?? [],
    };
    // Merge (don't replace) so the perms effect below and this one
    // can hydrate independently in either order.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable draft + dirty baseline from server-fetched user record on edit
    setDraft((d) => ({ ...d, ...fields }));
    setBaseline((b) => ({ ...b, ...fields }));
  }, [isEdit, detail.data]);

  useEffect(() => {
    if (!isEdit || !userPerms.data) return;
    // A user already in a saved role must show as that role, not
    // as "Custom" — otherwise a plain Save would push their matrix
    // through the overlay route and silently DETACH them.
    const savedId = detail.data?.user?.store_role_id ?? null;
    const p = savedId != null
      ? {
          access: `saved:${savedId}` as AccessMode,
          perm: structuredClone(userPerms.data.matrix),
        }
      : userPerms.data.has_custom
      ? {
          access: "custom" as const,
          perm: structuredClone(userPerms.data.matrix),
        }
      : { access: "role" as const, perm: null };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the custom-access half of the draft from the R-1 overlay endpoint
    setDraft((d) => ({ ...d, ...p }));
    setBaseline((b) => ({ ...b, ...p }));
  }, [isEdit, userPerms.data, detail.data]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("userForm.unsavedMessage"),
  });

  const isSelf = useMemo(() => {
    if (!isEdit || !detail.data || !identity) return false;
    return detail.data.user.id === identity.user_id;
  }, [isEdit, detail.data, identity]);

  function set<K extends keyof typeof draft>(
    key: K, value: (typeof draft)[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
    if (fieldErrors[key as string]) {
      setFieldErrors((e) => {
        const next = { ...e }; delete next[key as string]; return next;
      });
    }
  }

  const resources =
    userPerms.data?.resources
    ?? storePerms.data?.resources
    ?? FALLBACK_RESOURCES;
  const actions =
    userPerms.data?.actions
    ?? storePerms.data?.actions
    ?? FALLBACK_ACTIONS;

  function seedCustomMatrix(): PermMatrix {
    // Start "Custom" from what the user can do TODAY: their
    // resolved matrix on edit, their role's store matrix on create.
    if (isEdit && userPerms.data) {
      return structuredClone(userPerms.data.matrix);
    }
    const roleMatrix = storePerms.data?.matrix?.[draft.role];
    if (roleMatrix) return structuredClone(roleMatrix);
    return emptyMatrix(resources, actions);
  }

  function setAccess(mode: AccessMode) {
    setDraft((d) => {
      let perm = d.perm;
      const saved = savedRoleId(mode);
      if (saved != null) {
        // Show the saved role's matrix read-only: it is the role
        // that decides, and pretending otherwise would let someone
        // tick a box that the next role edit silently reverts.
        const role = accessRoles.data?.roles.find((r) => r.id === saved);
        perm = role ? structuredClone(role.matrix) : perm;
      } else if (mode === "custom") perm = perm ?? seedCustomMatrix();
      else perm = null;
      return { ...d, access: mode, perm };
    });
  }

  function togglePerm(resource: string, action: string) {
    setDraft((d) => {
      if (!d.perm) return d;
      const perm = structuredClone(d.perm);
      perm[resource] = toggleMatrixCell(perm[resource], action, resource);
      // Hand-editing any box means the matrix is theirs now.
      return { ...d, access: "custom", perm };
    });
  }

  if (isEdit && detail.isLoading) {
    return (
      <PageShell maxWidth="36rem">
        <PageHeader title={t("userForm.editUser")} />
        <Loading />
      </PageShell>
    );
  }
  if (isEdit && (detail.isError || !detail.data)) {
    return (
      <PageShell maxWidth="36rem">
        <PageHeader title={t("userForm.editUser")} />
        <ErrorState
          message={`${t("userForm.loadFailed")} ${apiErrorMessage(detail.error, "")}`.trimEnd()}
          onRetry={() => { void detail.refetch(); }}
        />
      </PageShell>
    );
  }
  if (isEdit && detail.data && detail.data.user.can_manage === false) {
    // Rank rule: this login outranks the viewer (the owner's own
    // account seen by a store admin). Nothing here is editable,
    // so there is no form to show.
    return (
      <PageShell maxWidth="36rem">
        <PageCrumbs under="/employees" current={t("userForm.editLogin")} />
        <PageHeader title={t("userForm.editUser")} />
        <Alert tone="info">
          {t("userForm.outranks", {
            name: detail.data.user.full_name || detail.data.user.username,
          })}
        </Alert>
      </PageShell>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setServerError(null);
    setFieldErrors({});
    try {
      // An accountant's access is fixed on the server: no module
      // filter, no saved role, no custom grid is sent for them.
      const isAccountant = draft.role === "accountant";
      const moduleAccess = draft.restrict && !isAccountant ? draft.modules : null;
      const savedRole = isAccountant ? null : savedRoleId(draft.access);
      // A saved role is applied through the role endpoint. Sending
      // its matrix to the per-user overlay route instead would
      // immediately DETACH the user from the role they were just
      // put in (R-3's hand-edit rule).
      const wantsCustom = !isAccountant
        && savedRole == null && draft.access !== "role" && draft.perm != null;
      if (isEdit) {
        const body: AdminUserUpdateBody = {
          full_name: draft.full_name,
          role:      draft.role,
          is_active: draft.is_active,
          module_access: moduleAccess,
        };
        if (draft.password) body.password = draft.password;
        await updateAdminUser(uid, body);
        // Custom access saves through the R-1 overlay endpoints —
        // only when it actually changed (each write revokes the
        // user's sessions, so no-op saves shouldn't log them out).
        // Moving someone to Accountant clears their saved role and
        // custom access on the server in the same save.
        if (!isSelf && !isAccountant && savedRole !== savedRoleId(baseline.access)) {
          await assignAccessRole(uid, savedRole);
        }
        if (!isSelf && !isAccountant && savedRole == null) {
          const hadCustom =
            baseline.access !== "role"
            && savedRoleId(baseline.access) == null;
          const permChanged =
            wantsCustom !== hadCustom
            || (wantsCustom
                && JSON.stringify(draft.perm)
                   !== JSON.stringify(baseline.perm));
          if (permChanged && wantsCustom && draft.perm) {
            await setAdminUserPermissions(uid, draft.perm);
          } else if (permChanged && !wantsCustom && hadCustom) {
            await clearAdminUserPermissions(uid);
          }
        }
      } else {
        const body: AdminUserCreateBody = {
          email:     draft.email.trim(),
          phone:     draft.phone.trim(),
          password:  draft.password,
          full_name: draft.full_name,
          role:      draft.role,
          module_access: moduleAccess,
        };
        if (savedRole != null) body.store_role_id = savedRole;
        else if (wantsCustom && draft.perm) body.permissions = draft.perm;
        const created = await createAdminUser(body);
        if (linkEmployeeId) {
          const { linkEmployeeLogin } = await import("../api/employees");
          await linkEmployeeLogin(linkEmployeeId, created.id);
          queryClient.invalidateQueries({ queryKey: ["employees"] });
        }
      }
      // Invalidate roster + this user's detail cache so the next
      // visit to /admin/users shows the updated row.
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({
        message: isEdit ? t("userForm.loginUpdated") : t("userForm.loginCreated"),
        tone: "success",
      });
      guard.proceed(() => navigate(
        linkEmployeeId
          ? `/employees/${linkEmployeeId}/edit`
          : "/employees",
      ));
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const detailBody = (err.body as {
          detail?: string | { field_errors?: Record<string, string> };
        })?.detail;
        if (detailBody && typeof detailBody === "object" && detailBody.field_errors) {
          setFieldErrors(detailBody.field_errors);
        } else {
          setServerError(apiErrorMessage(err, t("common.networkError")));
        }
      } else {
        setServerError(apiErrorMessage(err, t("common.networkError")));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="36rem">

      <PageCrumbs under="/employees" current={isEdit ? t("userForm.editLogin") : t("userForm.addLogin")} />

      <PageHeader title={isEdit ? t("userForm.editTitle") : t("userForm.addTitle")} />

      <Card>
        <div className={styles.cardHeader}>
          <span className={styles.cardHeaderText}>
            {isEdit ? t("userForm.updateAccount") : t("userForm.createAccount")}
          </span>
        </div>

        {serverError && <Alert tone="error">{serverError}</Alert>}

        <form
          onSubmit={onSubmit}
          autoComplete="off"
          style={{ display: "flex", flexDirection: "column", gap: space.lg, marginTop: space.lg }}
        >
          {!isEdit ? (
            <>
              <Field
                label={t("common.email")}
                error={fieldErrors.email}
                hint={t("userForm.emailHint")}
              >
                <Input
                  type="email" maxLength={255}
                  placeholder="maria.lopez@store.com"
                  value={draft.email}
                  onChange={(e) => set("email", e.target.value)}
                  disabled={busy}
                />
              </Field>
              <Field
                label={t("userForm.mobile")}
                error={fieldErrors.phone}
                hint={t("userForm.mobileHint")}
              >
                <Input
                  type="tel" maxLength={40}
                  placeholder="(555) 123-4567"
                  value={draft.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  disabled={busy}
                />
              </Field>
            </>
          ) : (
            <Field
              label={t("userForm.signsInWith")}
              hint={t("userForm.signsInWithHint")}
            >
              <Input
                type="text" disabled
                value={draft.username}
                style={{ opacity: 0.7, cursor: "not-allowed" }}
              />
            </Field>
          )}

          <Field label={t("userForm.fullName")} error={fieldErrors.full_name}>
            <Input
              type="text" maxLength={120}
              placeholder={t("userForm.fullNamePlaceholder")}
              value={draft.full_name}
              onChange={(e) => set("full_name", e.target.value)}
              disabled={busy}
            />
          </Field>

          <Field
            label={t("userForm.accountType")}
            error={fieldErrors.role}
            hint={isSelf ? t("userForm.selfRole") : undefined}
          >
            <Select
              value={draft.role}
              onChange={(e) => set("role", e.target.value)}
              disabled={busy || isSelf}
            >
              {assignableRoles.includes("employee") && (
                <option value="employee">{t("role.employee")}</option>
              )}
              {assignableRoles.includes("admin") && (
                <option value="admin">{t("userForm.adminFull")}</option>
              )}
              {(assignableRoles.includes("accountant") || draft.role === "accountant") && (
                <option value="accountant">{t("userForm.accountantViewOnly")}</option>
              )}
            </Select>
          </Field>

          {draft.role === "accountant" && (
            <Alert tone="info">
              {t("userForm.accountantNote")}
            </Alert>
          )}

          {!isSelf && draft.role !== "accountant" && (
            <Field
              label={t("employee.role")}
              hint={t("userForm.roleHint")}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                <Select
                  value={draft.access}
                  onChange={(e) => setAccess(e.target.value as AccessMode)}
                  disabled={busy}
                >
                  <option value="role">
                    {draft.role === "admin" ? t("userForm.adminBuiltin") : t("userForm.employeeBuiltin")}
                  </option>
                  {(accessRoles.data?.roles ?? []).length > 0 && (
                    <optgroup label={t("userForm.yourRoles")}>
                      {(accessRoles.data?.roles ?? []).map((r) => (
                        <option key={r.id} value={`saved:${r.id}`}>
                          {r.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <option value="custom">{t("userForm.customOnly")}</option>
                </Select>
                {draft.access !== "custom" && (
                  <RoleSummary
                    name={
                      savedRoleId(draft.access) != null
                        ? accessRoles.data?.roles.find(
                            (r) => r.id === savedRoleId(draft.access),
                          )?.name
                        : roleLabel(draft.role === "admin" ? "admin" : "employee")
                    }
                    to={
                      savedRoleId(draft.access) != null
                        ? `/team/roles/${savedRoleId(draft.access)}`
                        : `/team/roles/${draft.role === "admin" ? "admin" : "employee"}`
                    }
                    granted={areasGranted(
                      savedRoleId(draft.access) != null
                        ? draft.perm ?? undefined
                        : storePerms.data?.matrix[draft.role],
                    )}
                    total={resources.length}
                  />
                )}
                {draft.access !== "role" && draft.perm
                  && modulesOffForGrants(draft.perm, session.data?.features)
                    .map((flag) => (
                      <Alert key={flag} tone="warning">
                        {tNodes("userForm.moduleOff", {
                          module: <strong>{moduleLabel(flag)}</strong>,
                        })}
                      </Alert>
                    ))}
                {draft.access === "custom" && draft.perm && (
                  <>
                    <Alert tone="info">
                      {t("userForm.customNote")}
                    </Alert>
                    <PermissionMatrixTable
                      resources={resources}
                      actions={actions}
                      checked={(resource, action) => draft.perm?.[resource]?.[action] ?? false}
                      onToggle={togglePerm}
                      disabled={busy}
                      resourceHeader={t("userForm.area")}
                      grouped
                    />
                  </>
                )}
              </div>
            </Field>
          )}

          {draft.role !== "accountant" && (
          <Field
            label={t("userForm.moduleAccess")}
            error={fieldErrors.module_access}
            hint={t("userForm.moduleAccessHint")}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
              <Checkbox
                checked={draft.restrict}
                onChange={(v) => set("restrict", v)}
                disabled={busy}
              >
                {t("userForm.onlySelected")}
              </Checkbox>
              {draft.restrict && (
                <div style={{
                  display: "flex", flexDirection: "column",
                  gap: "0.35rem", paddingLeft: "1.6rem",
                }}>
                  {(session.data?.features ?? Object.keys(MODULE_LABELS))
                    .map((key) => (
                      <Checkbox
                        key={key}
                        checked={draft.modules.includes(key)}
                        onChange={(v) => set(
                          "modules",
                          v
                            ? [...draft.modules, key]
                            : draft.modules.filter((k) => k !== key),
                        )}
                        disabled={busy}
                      >
                        {moduleLabel(key)}
                      </Checkbox>
                    ))}
                </div>
              )}
            </div>
          </Field>
          )}

          <Field
            label={
              isEdit
                ? t("userForm.passwordKeep")
                : t("userForm.passwordRequired")
            }
            error={fieldErrors.password}
          >
            <Input
              type="password" maxLength={200}
              placeholder={t("userForm.passwordPlaceholder")}
              required={!isEdit}
              value={draft.password}
              onChange={(e) => set("password", e.target.value)}
              disabled={busy}
            />
          </Field>

          {isEdit && (
            <Field
              label=""
              error={fieldErrors.is_active}
              hint={isSelf ? t("userForm.selfActive") : undefined}
            >
              <Checkbox
                checked={draft.is_active}
                onChange={(v) => set("is_active", v)}
                disabled={busy || isSelf}
              >
                {t("userForm.accountActive")}
              </Checkbox>
            </Field>
          )}

          <FormActions guard={guard}>
            <Button
              type="button"
              tone="secondary"
              onClick={() => guard.confirmLeave(() => navigate(
                linkEmployeeId
                  ? `/employees/${linkEmployeeId}/edit`
                  : "/employees",
              ))}
              disabled={busy}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={busy} disabled={busy}>
              {busy ? t("common.saving") : (isEdit ? t("common.saveChanges") : t("userForm.createUser"))}
            </Button>
          </FormActions>
        </form>
      </Card>
    </PageShell>
  );
}

/** One line under the role picker in place of the grid: how much
 *  the role covers, and where to see or change it. */
function RoleSummary({
  name, to, granted, total,
}: {
  name: string | undefined;
  to: string;
  granted: number;
  total: number;
}) {
  const t = useT();
  return (
    <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--db-text-muted)" }}>
      {total > 0 && <>{t("userForm.canUse", { granted, total })} </>}
      <AppLink to={to}>{t("userForm.seeRole", { name: name ?? t("userForm.thisRole") })}</AppLink>
    </p>
  );
}

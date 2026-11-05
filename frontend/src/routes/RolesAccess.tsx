import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useAdminUsers, type AdminUserRow } from "../api/admin";
import {
  deleteAccessRole, useAccessRoles, useBuiltinRoles,
  type AccessRole, type PermMatrix, roleLabel,
} from "../api/roles";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { actionsFor, hasPermission } from "../lib/permissions";
import { areasGranted } from "../lib/roleTemplates";
import {
  actionLabel, actionShort, groupResources, resourceLabel,
} from "../components/PermissionMatrixTable";
import {
  ButtonLink, Card, ConfirmDialog, EmptyState, ErrorState,
  Loading, PageHeader, PageShell, Pill, RowActions, Section, TabsBar,
  TabsLink, Table, tdStyle, thStyle, useToast,
} from "../components/ui";
import styles from "./RolesAccess.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// Team → Roles & access. ONE place that says what each kind of
// person here can do: the two built-in roles (Admin / Employee —
// the store's defaults), the store's saved roles, and the people
// whose access was set by hand. Before this page those lived in
// three places (Team → Permissions, the bottom of Employees, and a
// grid inside every person's login form), and the login form grew
// a row for every area the product added.
//
// Two tabs, both compact: "Roles" lists one row per role; "Access
// by area" draws every area against every role, read-only, so
// "who can delete transfers?" is one look rather than N role
// pages. Editing a role happens on its own page (RoleEdit).

// The built-in roles a store edits here, named once in api/roles
// (and named at render, so the name follows the language).
const BUILTIN_ROLES = ["admin", "employee"];

interface RoleColumn {
  key: string;
  name: string;
  builtin: boolean;
  matrix: PermMatrix;
}

/** A person with no saved role and no hand-set grid follows the
 *  built-in role of their account type. */
function followsBuiltin(u: AdminUserRow): boolean {
  return u.store_role_id == null && !u.has_custom_permissions;
}

function personLabel(u: AdminUserRow): string {
  return u.full_name || u.username;
}

function peoplePill(n: number) {
  return (
    <Pill tone={n > 0 ? "accent" : "neutral"}>
      {tn("roles.people", n)}
    </Pill>
  );
}

export default function RolesAccess({
  view = "roles",
}: {
  view?: "roles" | "area";
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const t = useT();
  const saved = useAccessRoles();
  // The built-in defaults sit behind settings.read; without it the
  // page still works for saved roles, it just can't show them.
  const builtin = useBuiltinRoles(hasPermission("settings", "read"));
  const users = useAdminUsers();
  const [confirmDelete, setConfirmDelete] = useState<AccessRole | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove(role: AccessRole) {
    setBusy(true);
    try {
      const res = await deleteAccessRole(role.id);
      void qc.invalidateQueries({ queryKey: ["admin", "roles"] });
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast({
        message: res.detached.length
          ? tn("roles.deletedKeep", res.detached.length, String, { name: res.deleted })
          : t("roles.deleted", { name: res.deleted }),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("roles.deleteFailed"));
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  }

  const resources = saved.data?.resources ?? builtin.data?.resources ?? [];
  const people = (users.data?.rows ?? []).filter((u) => u.is_active);
  const custom = people.filter(
    (u) => u.store_role_id == null && u.has_custom_permissions,
  );

  const builtinColumns: RoleColumn[] = (builtin.data?.roles ?? [])
    .filter((r) => BUILTIN_ROLES.includes(r))
    .map((r) => ({
      key: r,
      name: roleLabel(r),
      builtin: true,
      matrix: builtin.data?.matrix[r] ?? {},
    }));
  const savedColumns: RoleColumn[] = (saved.data?.roles ?? []).map((r) => ({
    key: String(r.id),
    name: r.name,
    builtin: false,
    matrix: r.matrix,
  }));

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Roles & access")}
        subtitle={t("roles.subtitle")}
        actions={
          <ButtonLink tone="primary" to="/team/roles/new" perm="users.update">
            {t("roles.add")}
          </ButtonLink>
        }
      />

      <TabsBar>
        <TabsLink to="/team/roles" end>{t("roles.tabRoles")}</TabsLink>
        <TabsLink to="/team/roles/by-area">{t("roles.tabByArea")}</TabsLink>
      </TabsBar>

      {(saved.isLoading || builtin.isLoading) && <Loading />}
      {saved.isError && (
        <ErrorState
          message={t("roles.loadFailed")}
          onRetry={() => { void saved.refetch(); }}
        />
      )}

      {saved.data && view === "roles" && (
        <>
          <Card>
            <Table>
              <thead>
                <tr>
                  {[t("employee.role"), t("roles.colPeople"), t("roles.colAreas"), ""].map((h) => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {builtinColumns.map((col) => {
                  const editable =
                    (builtin.data?.editable_roles.includes(col.key) ?? false)
                    && hasPermission("settings", "update");
                  return (
                    <tr key={`builtin-${col.key}`}>
                      <td style={tdStyle}>
                        {col.name}{" "}
                        <Pill tone="neutral">{t("roles.builtin")}</Pill>
                      </td>
                      <td style={tdStyle}>
                        {peoplePill(people.filter(
                          (u) => u.role === col.key && followsBuiltin(u),
                        ).length)}
                      </td>
                      <td style={tdStyle} className={styles.num}>
                        {t("roles.areasOf", { granted: areasGranted(col.matrix), total: resources.length })}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <RowActions
                          title={col.name}
                          actions={[
                            {
                              label: editable ? t("common.edit") : t("roles.view"),
                              tone: "primary",
                              onClick: () => navigate(`/team/roles/${col.key}`),
                            },
                            {
                              label: t("roles.duplicate"),
                              perm: "users.update",
                              onClick: () => navigate(
                                `/team/roles/new?copy=${col.key}`,
                              ),
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
                {saved.data.roles.map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{r.name}</td>
                    <td style={tdStyle}>{peoplePill(r.member_count)}</td>
                    <td style={tdStyle} className={styles.num}>
                      {t("roles.areasOf", { granted: areasGranted(r.matrix), total: resources.length })}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <RowActions
                        title={r.name}
                        actions={[
                          {
                            label: t("common.edit"),
                            perm: "users.update",
                            tone: "primary",
                            onClick: () => navigate(`/team/roles/${r.id}`),
                          },
                          {
                            label: t("roles.duplicate"),
                            perm: "users.update",
                            onClick: () => navigate(
                              `/team/roles/new?copy=${r.id}`,
                            ),
                          },
                          {
                            label: t("roles.delete"),
                            perm: "users.update",
                            tone: "warning",
                            onClick: () => setConfirmDelete(r),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {saved.data.roles.length === 0 && (
              <EmptyState
                title={t("roles.emptyTitle")}
                body={t("roles.emptyBody")}
              />
            )}
          </Card>

          {custom.length > 0 && (
            <Section title={t("roles.customTitle")}>
              <Card>
                <p className={styles.lede}>
                  {t("roles.customBody")}
                </p>
                <Table>
                  <tbody>
                    {custom.map((u) => (
                      <tr key={u.id}>
                        <td style={tdStyle}>
                          {personLabel(u)}{" "}
                          <Pill tone="warning">{t("roles.customPill")}</Pill>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <RowActions
                            title={personLabel(u)}
                            actions={[
                              {
                                label: t("roles.saveAsRole"),
                                perm: "users.update",
                                tone: "primary",
                                onClick: () => navigate(
                                  `/team/roles/new?from_user=${u.id}`,
                                ),
                              },
                              {
                                label: t("roles.editAccess"),
                                perm: "users.update",
                                onClick: () => navigate(
                                  `/admin/users/${u.id}/edit`,
                                ),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </Section>
          )}
        </>
      )}

      {saved.data && view === "area" && (
        <AccessByArea
          resources={resources}
          actions={saved.data.actions}
          columns={[...builtinColumns, ...savedColumns]}
        />
      )}

      <ConfirmDialog
        open={confirmDelete != null}
        title={t("roles.deleteTitle", { name: confirmDelete?.name ?? "" })}
        confirmTone="danger"
        message={
          (confirmDelete?.member_count ?? 0) > 0
            ? tn("roles.deleteMembers", confirmDelete?.member_count ?? 0)
            : t("roles.deleteNobody")
        }
        confirmLabel={t("roles.deleteRole")}
        busy={busy}
        onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </PageShell>
  );
}

/** Every area × every role, read-only. Each cell is four small
 *  letters (C V E D) lit for what the role grants; a single-switch
 *  area (Lock / unlock days) shows its one letter. */
function AccessByArea({
  resources, actions, columns,
}: {
  resources: string[];
  actions: string[];
  columns: RoleColumn[];
}) {
  const t = useT();
  return (
    <Card>
      <div className={styles.scroll}>
        <table className={styles.areaTable}>
          <thead>
            <tr>
              <th>{t("userForm.area")}</th>
              {columns.map((c) => <th key={c.key}>{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {groupResources(resources).map((group) => [
              <tr key={`g-${group.key}`} className={styles.groupRow}>
                <td colSpan={columns.length + 1}>{group.title}</td>
              </tr>,
              ...group.resources.map((res) => (
                <tr key={res}>
                  <td>{resourceLabel(res)}</td>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <span className={styles.chips}>
                        {actionsFor(res, actions).map((a) => {
                          const on = c.matrix[res]?.[a] ?? false;
                          const label = actionLabel(a);
                          const yesNo = on ? t("roles.yes") : t("roles.no");
                          return (
                            <span
                              key={a}
                              className={on ? styles.chipOn : styles.chip}
                              title={`${label}: ${yesNo}`}
                              aria-label={`${c.name}, ${resourceLabel(res)}, ${label}: ${yesNo}`}
                            >
                              {actionShort(a)}
                            </span>
                          );
                        })}
                      </span>
                    </td>
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <p className={styles.legend}>
        {actions.map((a) => `${actionShort(a)} ${actionLabel(a).toLowerCase()}`).join(" · ")}
      </p>
    </Card>
  );
}

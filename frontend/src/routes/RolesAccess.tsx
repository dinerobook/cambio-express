import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { useAdminUsers, type AdminUserRow } from "../api/admin";
import {
  deleteAccessRole, useAccessRoles, useBuiltinRoles,
  type AccessRole, type PermMatrix,
} from "../api/roles";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { actionsFor, hasPermission } from "../lib/permissions";
import { areasGranted } from "../lib/roleTemplates";
import {
  ACTION_LABELS, RESOURCE_LABELS, groupResources,
} from "../components/PermissionMatrixTable";
import {
  Breadcrumbs, ButtonLink, Card, ConfirmDialog, EmptyState, ErrorState,
  Loading, PageHeader, PageShell, Pill, RowActions, Section, TabsBar,
  TabsLink, Table, tdStyle, thStyle, useToast,
} from "../components/ui";
import styles from "./RolesAccess.module.css";

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

const BUILTIN_LABELS: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
};

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
      {n === 1 ? "1 person" : `${n} people`}
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
          ? `Deleted "${res.deleted}". ${res.detached.length === 1
            ? "1 person keeps" : `${res.detached.length} people keep`} `
            + "the access they have now, as custom access."
          : `Deleted "${res.deleted}".`,
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, "Could not delete the role.");
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
    .filter((r) => r in BUILTIN_LABELS)
    .map((r) => ({
      key: r,
      name: BUILTIN_LABELS[r],
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
      <Breadcrumbs crumbs={[
        { label: "Team" },
        { label: "Roles & access" },
      ]} />
      <PageHeader
        title="Roles & access"
        subtitle="What each role can do here. Give people a role from their login; edit the role and everyone in it changes together."
        actions={
          <ButtonLink tone="primary" to="/team/roles/new" perm="users.update">
            + Add role
          </ButtonLink>
        }
      />

      <TabsBar>
        <TabsLink to="/team/roles" end>Roles</TabsLink>
        <TabsLink to="/team/roles/by-area">Access by area</TabsLink>
      </TabsBar>

      {(saved.isLoading || builtin.isLoading) && <Loading />}
      {saved.isError && (
        <ErrorState
          message="Could not load roles."
          onRetry={() => { void saved.refetch(); }}
        />
      )}

      {saved.data && view === "roles" && (
        <>
          <Card>
            <Table>
              <thead>
                <tr>
                  {["Role", "People", "Areas", ""].map((h) => (
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
                        <Pill tone="neutral">built-in</Pill>
                      </td>
                      <td style={tdStyle}>
                        {peoplePill(people.filter(
                          (u) => u.role === col.key && followsBuiltin(u),
                        ).length)}
                      </td>
                      <td style={tdStyle} className={styles.num}>
                        {areasGranted(col.matrix)} of {resources.length}
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <RowActions
                          title={col.name}
                          actions={[
                            {
                              label: editable ? "Edit" : "View",
                              tone: "primary",
                              onClick: () => navigate(`/team/roles/${col.key}`),
                            },
                            {
                              label: "Duplicate",
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
                      {areasGranted(r.matrix)} of {resources.length}
                    </td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <RowActions
                        title={r.name}
                        actions={[
                          {
                            label: "Edit",
                            perm: "users.update",
                            tone: "primary",
                            onClick: () => navigate(`/team/roles/${r.id}`),
                          },
                          {
                            label: "Duplicate",
                            perm: "users.update",
                            onClick: () => navigate(
                              `/team/roles/new?copy=${r.id}`,
                            ),
                          },
                          {
                            label: "Delete",
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
                title="No roles of your own yet"
                body="Add a role for each job here (Shift lead, Bookkeeper, Lottery cashier), then pick it on each person's login."
              />
            )}
          </Card>

          {custom.length > 0 && (
            <Section title="People with custom access">
              <Card>
                <p className={styles.lede}>
                  These people have access set just for them, so editing a
                  role does not change them. Save one as a role to reuse
                  their setup, or move them onto a role from their login.
                </p>
                <Table>
                  <tbody>
                    {custom.map((u) => (
                      <tr key={u.id}>
                        <td style={tdStyle}>
                          {personLabel(u)}{" "}
                          <Pill tone="warning">Custom</Pill>
                        </td>
                        <td style={{ ...tdStyle, textAlign: "right" }}>
                          <RowActions
                            title={personLabel(u)}
                            actions={[
                              {
                                label: "Save as role",
                                perm: "users.update",
                                tone: "primary",
                                onClick: () => navigate(
                                  `/team/roles/new?from_user=${u.id}`,
                                ),
                              },
                              {
                                label: "Edit access",
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
        title={`Delete "${confirmDelete?.name ?? ""}"`}
        message={
          (confirmDelete?.member_count ?? 0) > 0
            ? `${confirmDelete?.member_count === 1
              ? "1 person is" : `${confirmDelete?.member_count} people are`} `
              + "in this role. Deleting it does NOT change what they can "
              + "do: they keep exactly the access they have now, as "
              + "custom access."
            : "Nobody is in this role."
        }
        confirmLabel="Delete role"
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
  return (
    <Card>
      <div className={styles.scroll}>
        <table className={styles.areaTable}>
          <thead>
            <tr>
              <th>Area</th>
              {columns.map((c) => <th key={c.key}>{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {groupResources(resources).map((group) => [
              <tr key={`g-${group.title}`} className={styles.groupRow}>
                <td colSpan={columns.length + 1}>{group.title}</td>
              </tr>,
              ...group.resources.map((res) => (
                <tr key={res}>
                  <td>{RESOURCE_LABELS[res] ?? res}</td>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <span className={styles.chips}>
                        {actionsFor(res, actions).map((a) => {
                          const on = c.matrix[res]?.[a] ?? false;
                          const label = ACTION_LABELS[a] ?? a;
                          return (
                            <span
                              key={a}
                              className={on ? styles.chipOn : styles.chip}
                              title={`${label}: ${on ? "yes" : "no"}`}
                              aria-label={`${c.name}, ${RESOURCE_LABELS[res] ?? res}, ${label}: ${on ? "yes" : "no"}`}
                            >
                              {label.charAt(0)}
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
        {actions.map((a) => `${(ACTION_LABELS[a] ?? a).charAt(0)} ${(ACTION_LABELS[a] ?? a).toLowerCase()}`).join(" · ")}
      </p>
    </Card>
  );
}

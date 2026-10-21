import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  createEmployee, updateEmployee, useEmployees,
  type EmployeeRow, type LoginOnlyRow,
} from "../api/employees";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { fmtMoney2 } from "../lib/formatters";
import { pageOf, sortRows } from "../lib/pagination";
import { accountTypeLabel } from "../lib/permissions";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Breadcrumbs, ButtonLink, Card, ConfirmDialog, DataTable, PageHeader,
  PageShell, Pill, RowActions, Section, useToast, type DataColumn,
} from "../components/ui";

// /app/employees — the unified Employees hub (E-2). ONE place
// manages the person: HR record (payroll basics, personal
// details) + their optional login. Replaces the old Cashiers
// roster page and the Team Users page; /admin/users/* survives
// only as the login-credentials form the Login section links to.
//
// The roster comes whole (pickers across the app read the same
// endpoint), so sort and paging run here, in the URL like every list.

const SORT_KEYS: Record<string, (r: EmployeeRow) => string | number> = {
  name:   (r) => r.name,
  login:  (r) => r.login?.username ?? "",
  rate:   (r) => r.hourly_rate,
  hired:  (r) => r.hired_on ?? "",
  status: (r) => (r.is_active ? 1 : 0),
};

const LOGIN_ONLY_COLUMNS = (
  busy: boolean, adopt: (u: LoginOnlyRow) => void,
): DataColumn<LoginOnlyRow>[] => [
  { key: "login", header: "Login", render: (u) => <strong>{u.username}</strong> },
  { key: "name", header: "Name", render: (u) => u.full_name || "—" },
  {
    key: "role", header: "Role",
    render: (u) => (
      <Pill tone={u.role === "employee" ? "neutral" : "accent"}>
        {accountTypeLabel(u.role)}
      </Pill>
    ),
  },
  {
    key: "actions", header: "", label: "", align: "right",
    render: (u) => (
      <RowActions
        title={u.username}
        actions={[
          {
            label: "Create employee record",
            perm: "users.create",
            onClick: () => adopt(u),
            disabled: busy,
          },
        ]}
      />
    ),
  },
];

export default function Employees() {
  const identity = getCurrentIdentity();
  const { data, isLoading, isError, error, refetch } = useEmployees();
  const filters = useUrlFilterState({}, {
    pageSizeKey: "employees",
    defaultSort: { key: "name", direction: "asc" },
  });
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const navigate = useNavigate();
  const [confirmRow, setConfirmRow] = useState<EmployeeRow | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["employees"] });
  }

  async function toggleActive(row: EmployeeRow) {
    setBusy(true);
    try {
      await updateEmployee(row.id, { is_active: !row.is_active });
      toast({
        message: row.is_active
          ? `${row.name} deactivated.`
          : `${row.name} reactivated.`,
        tone: "success",
      });
      refresh();
    } catch (err) {
      toastApiError(err, "Could not update the employee.");
    } finally {
      setBusy(false);
      setConfirmRow(null);
    }
  }

  async function adoptLogin(row: LoginOnlyRow) {
    // "Create HR record" for a login-only account: mint the
    // employee row and link in one call.
    setBusy(true);
    try {
      const made = await createEmployee({
        name: row.full_name || row.username,
        user_id: row.user_id,
      });
      toast({ message: "Employee record created.", tone: "success" });
      refresh();
      navigate(`/employees/${made.id}/edit`);
    } catch (err) {
      toastApiError(err, "Could not create the employee record.");
    } finally {
      setBusy(false);
    }
  }

  const columns: DataColumn<EmployeeRow>[] = [
    { key: "name", header: "Name", sortKey: "name", render: (r) => <strong>{r.name}</strong> },
    { key: "login", header: "Login", sortKey: "login", render: (r) => <LoginCell row={r} /> },
    {
      key: "rate", header: "Rate", sortKey: "rate", sortFirst: "desc",
      render: (r) => (r.hourly_rate > 0 ? `${fmtMoney2(r.hourly_rate)}/hr` : "—"),
    },
    {
      key: "hired", header: "Hired", sortKey: "hired", sortFirst: "desc",
      render: (r) => (r.hired_on ? formatDate(r.hired_on) : "—"),
    },
    {
      key: "status", header: "Status", sortKey: "status", sortFirst: "desc",
      render: (r) => (
        <Pill tone={r.is_active ? "accent" : "neutral"}>
          {r.is_active ? "Active" : "Inactive"}
        </Pill>
      ),
    },
    {
      key: "actions", header: "", label: "", align: "right",
      render: (r) => (
        <RowActions
          title={r.name}
          actions={[
            {
              label: "Edit",
              perm: "users.update",
              onClick: () => navigate(`/employees/${r.id}/edit`),
            },
            // No access, no control: a login that outranks the
            // viewer (the owner's own account seen by an admin)
            // gets no access or deactivate actions — the server
            // refuses them anyway.
            ...(r.login && !r.login.can_manage ? [] : [
              {
                // Deep-links the form's Login tab (E-3) — "who can
                // sign in" is the most common reason to open
                // somebody's record.
                label: r.login ? "Manage access" : "Add login",
                perm: "users.update",
                onClick: () => navigate(`/employees/${r.id}/edit?tab=login`),
              },
              r.is_active
                ? {
                    label: "Deactivate", tone: "danger" as const,
                    perm: "users.update",
                    onClick: () => setConfirmRow(r),
                    disabled: busy,
                  }
                : {
                    label: "Reactivate",
                    perm: "users.update",
                    onClick: () => { void toggleActive(r); },
                    disabled: busy,
                  },
            ]),
          ]}
        />
      ),
    },
  ];

  // Who may be here is the route table's call (users.read via
  // <Gate>), not a role check duplicated in the page.
  if (!identity) return null;

  const sorted = sortRows(data?.rows ?? [], SORT_KEYS, filters.sort?.key, filters.sort?.direction);
  const shown = pageOf(sorted, filters.page, filters.perPage);
  const loginOnly = data?.login_only ?? [];

  return (
    <PageShell>
      <Breadcrumbs crumbs={[{ label: "Employees" }]} />
      <PageHeader
        title="Employees"
        subtitle="Everyone who works here — profile, payroll, and login in one place."
        actions={(
          <ButtonLink href="/employees/new" tone="primary" size="sm">
            + Add Employee
          </ButtonLink>
        )}
      />

      <Card>
        <DataTable
          columns={columns}
          rows={data ? shown.rows : undefined}
          rowKey={(r) => r.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle="No employees yet"
          emptyBody='Click "+ Add Employee" to add your first person.'
          sort={filters.sort}
          page={{
            page: shown.page, totalPages: shown.totalPages, total: shown.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>

      {loginOnly.length > 0 && (
        <Section title="Logins without an employee record">
          <Card>
            <p style={{ marginTop: 0 }}>
              These accounts can sign in but have no HR record yet —
              create one so their payroll and personal details live
              here too.
            </p>
            <DataTable
              columns={LOGIN_ONLY_COLUMNS(busy, (u) => { void adoptLogin(u); })}
              rows={loginOnly}
              rowKey={(u) => u.user_id}
              emptyTitle="No logins without a record."
            />
          </Card>
        </Section>
      )}

      <ConfirmDialog
        open={confirmRow != null}
        title="Deactivate employee"
        message={`Deactivate ${confirmRow?.name ?? "this employee"}? They disappear from attribution dropdowns and the time clock; history is kept. A linked login stays active — disable it from the Login section if they should also lose access.`}
        confirmLabel="Deactivate"
        confirmTone="danger"
        busy={busy}
        onConfirm={() => { if (confirmRow) void toggleActive(confirmRow); }}
        onCancel={() => setConfirmRow(null)}
      />
    </PageShell>
  );
}

function LoginCell({ row: r }: { row: EmployeeRow }) {
  if (!r.login) return <Pill tone="neutral">No login</Pill>;
  return (
    <>
      <Pill tone={r.login.role === "employee" ? "neutral" : "accent"}>
        {accountTypeLabel(r.login.role)}
      </Pill>{" "}
      <span>{r.login.username}</span>
      {/* Name the saved role when there is one — "Shift lead" says
          more than "Custom access" (R-3). */}
      {r.login.store_role_name ? (
        <>
          {" "}
          <Pill tone="accent">{r.login.store_role_name}</Pill>
        </>
      ) : r.login.has_custom_permissions ? (
        <>
          {" "}
          <Pill tone="neutral">Custom access</Pill>
        </>
      ) : null}
      {!r.login.is_active && (
        <>
          {" "}
          <Pill tone="neutral">Login inactive</Pill>
        </>
      )}
    </>
  );
}

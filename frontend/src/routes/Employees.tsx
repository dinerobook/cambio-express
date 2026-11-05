import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  createEmployee, updateEmployee, useEmployees,
  type EmployeeRow, type LoginOnlyRow,
} from "../api/employees";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { getCurrentIdentity } from "../lib/auth";
import { csvDate, formatDate } from "../lib/datetime";
import { csvMoney } from "../lib/csv";
import { fmtMoney2 } from "../lib/formatters";
import { pageOf, sortRows } from "../lib/pagination";
import { accountTypeLabel } from "../lib/permissions";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  ButtonLink, Card, ConfirmDialog, DataTable, PageHeader,
  PageShell, Pill, RowActions, Section, useToast, type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT, type Translate } from "../i18n";
import { navWord } from "../i18n/navWords";

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

const loginOnlyColumns = (
  t: Translate, busy: boolean, adopt: (u: LoginOnlyRow) => void,
): DataColumn<LoginOnlyRow>[] => [
  { key: "login", header: t("employee.login"), render: (u) => <strong>{u.username}</strong> },
  { key: "name", header: t("common.name"), render: (u) => u.full_name || "—" },
  {
    key: "role", header: t("employee.role"),
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
            label: t("employee.createRecord"),
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
  const t = useT();
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
          ? t("employee.deactivated", { name: row.name })
          : t("employee.reactivated", { name: row.name }),
        tone: "success",
      });
      refresh();
    } catch (err) {
      toastApiError(err, t("employee.updateFailed"));
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
      toast({ message: t("employee.recordCreated"), tone: "success" });
      refresh();
      navigate(`/employees/${made.id}/edit`);
    } catch (err) {
      toastApiError(err, t("employee.recordCreateFailed"));
    } finally {
      setBusy(false);
    }
  }

  const columns: DataColumn<EmployeeRow>[] = [
    { key: "name", header: t("common.name"), sortKey: "name", render: (r) => <strong>{r.name}</strong>,
      csv: (r) => r.name },
    { key: "login", header: t("employee.login"), sortKey: "login", render: (r) => <LoginCell row={r} />,
      csv: (r) => r.login?.username ?? "" },
    {
      key: "rate", header: t("employee.rate"), sortKey: "rate", sortFirst: "desc",
      render: (r) => (r.hourly_rate > 0 ? t("employee.perHour", { amount: fmtMoney2(r.hourly_rate) }) : "—"),
      csvHeader: t("employee.hourlyRate"),
      csv: (r) => (r.hourly_rate > 0 ? csvMoney(r.hourly_rate) : ""),
    },
    {
      key: "hired", header: t("employee.hired"), sortKey: "hired", sortFirst: "desc",
      render: (r) => (r.hired_on ? formatDate(r.hired_on) : "—"),
      csv: (r) => csvDate(r.hired_on),
    },
    {
      key: "status", header: t("common.status"), sortKey: "status", sortFirst: "desc",
      render: (r) => (
        <Pill tone={r.is_active ? "accent" : "neutral"}>
          {r.is_active ? t("common.active") : t("common.inactive")}
        </Pill>
      ),
      csv: (r) => (r.is_active ? t("common.active") : t("common.inactive")),
    },
    {
      key: "actions", header: "", label: "", align: "right",
      render: (r) => (
        <RowActions
          title={r.name}
          actions={[
            {
              label: t("common.edit"),
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
                label: r.login ? t("employee.manageAccess") : t("employee.addLogin"),
                perm: "users.update",
                onClick: () => navigate(`/employees/${r.id}/edit?tab=login`),
              },
              r.is_active
                ? {
                    label: t("employee.deactivate"), tone: "danger" as const,
                    perm: "users.update",
                    onClick: () => setConfirmRow(r),
                    disabled: busy,
                  }
                : {
                    label: t("employee.reactivate"),
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
      <PageCrumbs />
      <PageHeader
        title={navWord("Employees")}
        subtitle={t("employee.subtitle")}
        actions={(
          <ButtonLink to="/employees/new" tone="primary" size="sm">
            {t("employee.add")}
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
          emptyTitle={t("employee.emptyTitle")}
          emptyBody={t("employee.emptyBody")}
          sort={filters.sort}
          page={{
            page: shown.page, totalPages: shown.totalPages, total: shown.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "employees",
            allRows: sorted,
            extraColumns: [
              { header: t("employee.accountType"), csv: (r) => (r.login ? accountTypeLabel(r.login.role) : "") },
            ],
          }}
        />
      </Card>

      {loginOnly.length > 0 && (
        <Section title={t("employee.loginOnlyTitle")}>
          <Card>
            <p style={{ marginTop: 0 }}>
              {t("employee.loginOnlyBody")}
            </p>
            <DataTable
              columns={loginOnlyColumns(t, busy, (u) => { void adoptLogin(u); })}
              rows={loginOnly}
              rowKey={(u) => u.user_id}
              emptyTitle={t("employee.loginOnlyEmpty")}
            />
          </Card>
        </Section>
      )}

      <ConfirmDialog
        open={confirmRow != null}
        title={t("employee.deactivateTitle")}
        message={t("employee.deactivateBody", { name: confirmRow?.name ?? t("employee.thisEmployee") })}
        confirmLabel={t("employee.deactivate")}
        confirmTone="danger"
        busy={busy}
        onConfirm={() => { if (confirmRow) void toggleActive(confirmRow); }}
        onCancel={() => setConfirmRow(null)}
      />
    </PageShell>
  );
}

function LoginCell({ row: r }: { row: EmployeeRow }) {
  const t = useT();
  if (!r.login) return <Pill tone="neutral">{t("employee.noLogin")}</Pill>;
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
          <Pill tone="neutral">{t("employee.customAccess")}</Pill>
        </>
      ) : null}
      {!r.login.is_active && (
        <>
          {" "}
          <Pill tone="neutral">{t("employee.loginInactive")}</Pill>
        </>
      )}
    </>
  );
}

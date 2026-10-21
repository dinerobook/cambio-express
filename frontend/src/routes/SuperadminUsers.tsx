import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  changeUserRole,
  createPlatformUser,
  forcePasswordReset,
  resetUser2FA,
  revokeUserSessions,
  toggleUserActive,
  useSuperadminStores,
  useSuperadminUsers,
  type SuperadminUserRow,
} from "../api/superadmin";
import { roleTone } from "../api/roles";
import { apiErrorMessage } from "../lib/api";
import { startImpersonation } from "../lib/impersonation";
import { formatDate } from "../lib/datetime";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  PageHeader,
  PageShell,
  Pill,
  RowActions,
  Select,
  useToast,
  type DataColumn,
} from "../components/ui";
import styles from "./SuperadminUsers.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";

type UserAction =
  | "toggle" | "reset2fa" | "resetpw" | "impersonate" | "view" | "revokesessions";

const ROLES = [
  { value: "", label: "All roles" },
  { value: "admin", label: "Admin" },
  { value: "employee", label: "Employee" },
  { value: "owner", label: "Owner" },
  { value: "superadmin", label: "Superadmin" },
  { value: "support", label: "Support" },
];

export default function SuperadminUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  // Filters and page live in the URL (shareable, back/forward
  // restore them); the search box applies as you type (300ms
  // debounce, 2-char minimum), the selects at once.
  const filters = useUrlFilterState(
    { q: "", role: "", store_id: "" },
    { pageSizeKey: "superadmin-users" },
  );
  const q = filters.params.q.trim();
  const role = filters.params.role;
  const storeFilter = filters.params.store_id ? Number(filters.params.store_id) : undefined;
  const stores = useSuperadminStores();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A refused role change keeps its dialog open, so its error shows there.
  const [roleError, setRoleError] = useState<string | null>(null);
  const [tempPw, setTempPw] = useState<{ userId: number; password: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    userId: number; username: string; action: UserAction;
  } | null>(null);
  const [showAddSupport, setShowAddSupport] = useState(false);
  const [roleChange, setRoleChange] = useState<{
    userId: number; username: string; currentRole: string;
  } | null>(null);
  const [newRole, setNewRole] = useState("");

  const { data, isLoading, isError, error: fetchError, refetch } =
    useSuperadminUsers({
      q: q.length >= 2 ? q : undefined, role: role || undefined,
      store_id: storeFilter, page: filters.page, perPage: filters.perPage,
    });

  function refresh() {
    qc.invalidateQueries({ queryKey: ["superadmin", "users"] });
  }

  async function doAction() {
    if (!confirmAction) return;
    const { userId, action } = confirmAction;
    setBusyId(userId);
    setError(null);
    setTempPw(null);
    try {
      if (action === "toggle") {
        const res = await toggleUserActive(userId);
        toast({
          message: res.is_active ? "User enabled." : "User disabled.",
          tone: "success",
        });
        refresh();
      } else if (action === "reset2fa") {
        await resetUser2FA(userId);
        toast({ message: "2FA cleared — user can re-enroll at next login.", tone: "success" });
        refresh();
      } else if (action === "resetpw") {
        const res = await forcePasswordReset(userId);
        setTempPw({ userId, password: res.temp_password });
        toast({ message: "Password reset.", tone: "success" });
        refresh();
      } else if (action === "impersonate") {
        await startImpersonation(userId, "full");
        return;
      } else if (action === "view") {
        await startImpersonation(userId, "read_only");
        return;
      } else if (action === "revokesessions") {
        const res = await revokeUserSessions(userId);
        toast({
          message: res.revoked_count > 0
            ? `Revoked ${res.revoked_count} active session${res.revoked_count === 1 ? "" : "s"}.`
            : "No active sessions to revoke.",
          tone: "success",
        });
        refresh();
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Action failed."));
    } finally {
      setBusyId(null);
      setConfirmAction(null);
    }
  }

  const confirmMessages: Record<string, string> = {
    toggle: `Toggle active status for "${confirmAction?.username}"?`,
    reset2fa: `Clear 2FA enrollment for "${confirmAction?.username}"? They'll need to re-enroll at next login.`,
    resetpw: `Reset password for "${confirmAction?.username}"? A temporary password will be generated.`,
    impersonate: `Sign in as "${confirmAction?.username}"? You'll leave this page and see the app from their perspective. Anything you save is recorded against them as "via superadmin". This is audit-logged.`,
    view: `View the app as "${confirmAction?.username}"? Read-only: every save on that session is refused, so you can look without changing their books. This is audit-logged.`,
    revokesessions: `Revoke every active session for "${confirmAction?.username}"? They'll be bounced to the login page on their next API call. Use for compromised credentials, departing staff, or any "lock them out now" incident.`,
  };

  return (
    <PageShell>
      <PageCrumbs />

      <PageHeader
        title="Users"
        subtitle={data ? `${fmtNumber(data.total)} users` : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder="Search name, email, username…"
              aria-label="Search users"
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={role}
              aria-label="Role"
              onChange={(e) => filters.setParam("role", e.target.value)}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </Select>
            <Select
              value={filters.params.store_id}
              aria-label="Store"
              onChange={(e) => filters.setParam("store_id", e.target.value)}
            >
              <option value="">All stores</option>
              {(stores.data?.rows ?? []).map((s) => (
                <option key={s.store_id} value={s.store_id}>{s.name}</option>
              ))}
            </Select>
          </div>
        )}
      />

      {error && <Alert tone="error">{error}</Alert>}

      <div className={styles.addSupportRow}>
        <Button
          tone="secondary"
          onClick={() => setShowAddSupport((v) => !v)}
        >
          {showAddSupport ? "Cancel" : "Add support login"}
        </Button>
      </div>

      {showAddSupport && (
        <AddSupportLoginCard
          onCreated={() => {
            setShowAddSupport(false);
            refresh();
          }}
        />
      )}

      {tempPw && (
        <Alert tone="success">
          <div className={styles.tempPwLabel}>
            Temporary password (show to the user — it won't be displayed again):
          </div>
          <div className={styles.tempPw}>{tempPw.password}</div>
        </Alert>
      )}

      <Card>
        <DataTable
          columns={userColumns({
            busyId,
            onAction: (u, action) =>
              setConfirmAction({ userId: u.id, username: u.username, action }),
            onChangeRole: (u) => {
              setRoleChange({ userId: u.id, username: u.username, currentRole: u.role });
              setNewRole("");
            },
          })}
          rows={data?.rows}
          rowKey={(u) => u.id}
          isLoading={isLoading} isError={isError} error={fetchError}
          onRetry={() => { void refetch(); }}
          emptyTitle="No users match these filters."
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
        />
      </Card>

      <ConfirmDialog
        open={confirmAction != null}
        title={
          confirmAction?.action === "toggle" ? "Toggle user"
          : confirmAction?.action === "reset2fa" ? "Reset 2FA"
          : confirmAction?.action === "resetpw" ? "Reset password"
          : confirmAction?.action === "revokesessions" ? "Revoke sessions"
          : confirmAction?.action === "view" ? "View as user"
          : "Impersonate user"
        }
        message={confirmMessages[confirmAction?.action ?? "toggle"] ?? ""}
        confirmLabel={
          confirmAction?.action === "impersonate" ? "Sign in as user"
          : confirmAction?.action === "view" ? "View read-only"
          : confirmAction?.action === "revokesessions" ? "Revoke sessions"
          : "Confirm"
        }
        confirmTone={
          confirmAction?.action === "impersonate" ? "danger"
          : confirmAction?.action === "revokesessions" ? "danger"
          : "primary"
        }
        busy={busyId != null}
        onConfirm={() => { void doAction(); }}
        onCancel={() => setConfirmAction(null)}
      />

      <ConfirmDialog
        open={roleChange != null}
        title="Change role"
        message={(
          <>
            Change role for &quot;{roleChange?.username}&quot; from {roleChange?.currentRole} to:
            <Select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              style={{ marginTop: "0.5rem" }}
            >
              <option value="">— Select role —</option>
              <option value="admin">Admin</option>
              <option value="employee">Employee</option>
              <option value="owner">Owner</option>
            </Select>
          </>
        )}
        confirmLabel={busyId != null ? "Saving…" : "Change role"}
        busy={busyId != null}
        onConfirm={() => {
          if (!roleChange || !newRole) return;
          setBusyId(roleChange.userId);
          setRoleError(null);
          changeUserRole(roleChange.userId, newRole)
            .then(() => {
              toast({ message: `Role changed to ${newRole}.`, tone: "success" });
              refresh();
              setRoleChange(null);
              setNewRole("");
            })
            .catch((err) => {
              setRoleError(apiErrorMessage(err, "Failed to change role."));
            })
            .finally(() => setBusyId(null));
        }}
        error={roleError}
        onCancel={() => { setRoleChange(null); setNewRole(""); setRoleError(null); }}
      />
    </PageShell>
  );
}


function userColumns({ busyId, onAction, onChangeRole }: {
  busyId: number | null;
  onAction: (user: SuperadminUserRow, action: UserAction) => void;
  onChangeRole: (user: SuperadminUserRow) => void;
}): DataColumn<SuperadminUserRow>[] {
  return [
    {
      key: "user", header: "User",
      render: (u) => (
        <div>
          <div className={styles.userName}>{u.full_name || u.username}</div>
          <div className={styles.userMeta}>
            {u.username}
            {u.email ? ` · ${u.email}` : ""}
          </div>
        </div>
      ),
    },
    { key: "role", header: "Role", render: (u) => <RolePill role={u.role} /> },
    {
      key: "store", header: "Store",
      render: (u) => (u.store_name
        ? <span>{u.store_name}</span>
        : <span className={styles.monoMuted}>—</span>),
    },
    {
      key: "status", header: "Status",
      render: (u) => (
        <Pill tone={u.is_active ? "accent" : "neutral"}>
          {u.is_active ? "Active" : "Inactive"}
        </Pill>
      ),
    },
    {
      key: "2fa", header: "2FA",
      render: (u) => (u.has_2fa
        ? <Pill tone="success">Enrolled</Pill>
        : <span className={styles.monoMuted}>—</span>),
    },
    {
      key: "last", header: "Last login",
      render: (u) => (
        <span className={styles.monoMuted}>
          {u.last_login_at ? formatDate(u.last_login_at) : "Never"}
        </span>
      ),
    },
    {
      key: "actions", header: "Actions", label: "", align: "right",
      render: (u) => (u.role === "superadmin" ? null : (
        <RowActions
          actions={[
            {
              label: "Change role",
              onClick: () => onChangeRole(u),
              disabled: busyId === u.id,
            },
            {
              label: u.is_active ? "Disable" : "Enable",
              onClick: () => onAction(u, "toggle"),
              disabled: busyId === u.id,
            },
            {
              label: "Reset password",
              onClick: () => onAction(u, "resetpw"),
              disabled: busyId === u.id,
            },
            ...(u.has_2fa ? [{
              label: "Reset 2FA",
              onClick: () => onAction(u, "reset2fa"),
              disabled: busyId === u.id,
            }] : []),
            {
              label: "View as (read-only)",
              onClick: () => onAction(u, "view"),
              disabled: busyId === u.id,
            },
            {
              label: "Impersonate",
              onClick: () => onAction(u, "impersonate"),
              disabled: busyId === u.id,
            },
            {
              label: "Revoke sessions",
              onClick: () => onAction(u, "revokesessions"),
              disabled: busyId === u.id,
            },
          ]}
        />
      )),
    },
  ];
}


function RolePill({ role }: { role: string }) {
  return <Pill tone={roleTone(role)}>{role}</Pill>;
}

/** Inline create form for a store-less "support" platform login —
 *  tickets-only role, password sign-in with a 7-day login window.
 *  The role is fixed server-side (POST /superadmin/platform-users
 *  only mints support). */
function AddSupportLoginCard({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createPlatformUser({
        username: username.trim(),
        full_name: fullName.trim(),
        email: email.trim(),
        password,
      });
      toast({
        message: `Support login "${username.trim()}" created.`,
        tone: "success",
      });
      onCreated();
    } catch (err) {
      setError(
        apiErrorMessage(err, "Could not create the login."),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit} autoComplete="off">
        <p className={styles.addSupportLead}>
          Support logins can only work the ticket queue - no store
          data, no platform controls. They sign in with a password
          and are logged out automatically 7 days after each login.
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className={styles.addSupportGrid}>
          <Field label="Username">
            <Input
              value={username} required minLength={3} maxLength={80}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="Full name">
            <Input
              value={fullName} maxLength={120}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label="Email" hint="Ticket-update emails go here.">
            <Input
              type="email" value={email} maxLength={255}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input
              type="password" value={password} required
              minLength={8} maxLength={200}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" busy={busy} disabled={busy}>
          {busy ? "Creating\u2026" : "Create support login"}
        </Button>
      </form>
    </Card>
  );
}

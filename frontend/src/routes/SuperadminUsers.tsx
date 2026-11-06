import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  changeUserRole,
  createPlatformUser,
  fetchSuperadminUsers,
  forcePasswordReset,
  resetUser2FA,
  revokeUserSessions,
  toggleUserActive,
  useSuperadminStores,
  useSuperadminUsers,
  type SuperadminUserRow,
} from "../api/superadmin";
import { RolePill } from "../components/RolePill";
import { apiErrorMessage } from "../lib/api";
import { startImpersonation } from "../lib/impersonation";
import { csvTimestamp, formatDate } from "../lib/datetime";
import { roleLabel } from "../api/roles";
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
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

type UserAction =
  | "toggle" | "reset2fa" | "resetpw" | "impersonate" | "view" | "revokesessions";

const ROLES = ["admin", "employee", "owner", "superadmin", "support"];

// The roles a superadmin can move a store login between.
const CHANGEABLE_ROLES = ["admin", "employee", "owner"];

const CONFIRM_TITLES: Record<UserAction, MessageKey> = {
  toggle: "saUsers.titleToggle",
  reset2fa: "saUsers.titleReset2fa",
  resetpw: "saUsers.titleResetPw",
  revokesessions: "saUsers.titleRevoke",
  view: "saUsers.titleView",
  impersonate: "saUsers.titleImpersonate",
};

const CONFIRM_MESSAGES: Record<UserAction, MessageKey> = {
  toggle: "saUsers.confirmToggle",
  reset2fa: "saUsers.confirmReset2fa",
  resetpw: "saUsers.confirmResetPw",
  impersonate: "saUsers.confirmImpersonate",
  view: "saUsers.confirmView",
  revokesessions: "saUsers.confirmRevoke",
};

export default function SuperadminUsers() {
  const t = useT();
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

  const listQuery = {
    q: q.length >= 2 ? q : undefined, role: role || undefined,
    store_id: storeFilter,
  };
  const { data, isLoading, isError, error: fetchError, refetch } =
    useSuperadminUsers({
      ...listQuery, page: filters.page, perPage: filters.perPage,
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
          message: res.is_active ? t("saUsers.enabled") : t("saUsers.disabled"),
          tone: "success",
        });
        refresh();
      } else if (action === "reset2fa") {
        await resetUser2FA(userId);
        toast({ message: t("saUsers.tfaCleared"), tone: "success" });
        refresh();
      } else if (action === "resetpw") {
        const res = await forcePasswordReset(userId);
        setTempPw({ userId, password: res.temp_password });
        toast({ message: t("saUsers.pwReset"), tone: "success" });
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
            ? tn("saUsers.revoked", res.revoked_count, fmtNumber)
            : t("saUsers.noSessions"),
          tone: "success",
        });
        refresh();
      }
    } catch (err) {
      setError(apiErrorMessage(err, t("saUsers.actionFailed")));
    } finally {
      setBusyId(null);
      setConfirmAction(null);
    }
  }


  return (
    <PageShell>
      <PageCrumbs />

      <PageHeader
        title={navWord("Users")}
        subtitle={data ? tn("saUsers.users", data.total, fmtNumber) : "—"}
        actions={(
          <div className={styles.filterRow}>
            <Input
              type="search"
              value={filters.draft.q ?? filters.params.q}
              placeholder={t("saUsers.search")}
              aria-label={t("saUsers.searchLabel")}
              onChange={(e) => filters.debounced("q", e.target.value)}
              className={styles.searchInput}
            />
            <Select
              value={role}
              aria-label={t("saUsers.role")}
              onChange={(e) => filters.setParam("role", e.target.value)}
            >
              <option value="">{t("saUsers.allRoles")}</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </Select>
            <Select
              value={filters.params.store_id}
              aria-label={t("saUsers.colStore")}
              onChange={(e) => filters.setParam("store_id", e.target.value)}
            >
              <option value="">{t("saTix.allStores")}</option>
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
          {showAddSupport ? t("common.cancel") : t("saUsers.addSupport")}
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
            {t("saUsers.tempPw")}
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
          emptyTitle={t("saUsers.empty")}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "users",
            fetchPage: (page, perPage) => fetchSuperadminUsers({ ...listQuery, page, perPage }),
            extraColumns: [
              { header: t("saUsers.colUsername"), csv: (u) => u.username },
              { header: t("common.email"), csv: (u) => u.email },
            ],
          }}
        />
      </Card>

      <ConfirmDialog
        open={confirmAction != null}
        title={t(CONFIRM_TITLES[confirmAction?.action ?? "impersonate"])}
        message={confirmAction
          ? t(CONFIRM_MESSAGES[confirmAction.action], { name: confirmAction.username })
          : ""}
        confirmLabel={
          confirmAction?.action === "impersonate" ? t("saUsers.signInAs")
          : confirmAction?.action === "view" ? t("saUsers.viewReadOnly")
          : confirmAction?.action === "revokesessions" ? t("saUsers.titleRevoke")
          : t("common.confirm")
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
        title={t("saUsers.changeRole")}
        message={(
          <>
            {t("saUsers.changeRoleBody", {
              name: roleChange?.username ?? "", role: roleLabel(roleChange?.currentRole ?? ""),
            })}
            <Select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              style={{ marginTop: "0.5rem" }}
            >
              <option value="">{t("saUsers.selectRole")}</option>
              {CHANGEABLE_ROLES.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </Select>
          </>
        )}
        confirmLabel={busyId != null ? t("common.saving") : t("saUsers.changeRole")}
        busy={busyId != null}
        onConfirm={() => {
          if (!roleChange || !newRole) return;
          setBusyId(roleChange.userId);
          setRoleError(null);
          changeUserRole(roleChange.userId, newRole)
            .then(() => {
              toast({ message: t("saUsers.roleChanged", { role: roleLabel(newRole) }), tone: "success" });
              refresh();
              setRoleChange(null);
              setNewRole("");
            })
            .catch((err) => {
              setRoleError(apiErrorMessage(err, t("saUsers.roleFailed")));
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
  const t = translate;
  return [
    {
      key: "user", header: t("saUsers.colUser"),
      render: (u) => (
        <div>
          <div className={styles.userName}>{u.full_name || u.username}</div>
          <div className={styles.userMeta}>
            {u.username}
            {u.email ? ` · ${u.email}` : ""}
          </div>
        </div>
      ),
      csv: (u) => u.full_name || u.username,
    },
    { key: "role", header: t("saUsers.role"), render: (u) => <RolePill role={u.role} />, csv: (u) => roleLabel(u.role) },
    {
      key: "store", header: t("saUsers.colStore"),
      render: (u) => (u.store_name
        ? <span>{u.store_name}</span>
        : <span className={styles.monoMuted}>—</span>),
      csv: (u) => u.store_name,
    },
    {
      key: "status", header: t("common.status"),
      render: (u) => (
        <Pill tone={u.is_active ? "accent" : "neutral"}>
          {u.is_active ? t("common.active") : t("common.inactive")}
        </Pill>
      ),
      csv: (u) => (u.is_active ? t("common.active") : t("common.inactive")),
    },
    {
      key: "2fa", header: t("saUsers.col2fa"),
      render: (u) => (u.has_2fa
        ? <Pill tone="success">{t("saUsers.enrolled")}</Pill>
        : <span className={styles.monoMuted}>—</span>),
      csv: (u) => (u.has_2fa ? t("saUsers.enrolled") : ""),
    },
    {
      key: "last", header: t("saUsers.colLastLogin"),
      render: (u) => (
        <span className={styles.monoMuted}>
          {u.last_login_at ? formatDate(u.last_login_at) : t("saUsers.never")}
        </span>
      ),
      csv: (u) => (u.last_login_at ? csvTimestamp(u.last_login_at) : t("saUsers.never")),
    },
    {
      key: "actions", header: t("common.actions"), label: "", align: "right",
      render: (u) => (u.role === "superadmin" ? null : (
        <RowActions
          actions={[
            {
              label: t("saUsers.changeRole"),
              onClick: () => onChangeRole(u),
              disabled: busyId === u.id,
            },
            {
              label: u.is_active ? t("saUsers.disable") : t("saUsers.enable"),
              onClick: () => onAction(u, "toggle"),
              disabled: busyId === u.id,
            },
            {
              label: t("saUsers.titleResetPw"),
              onClick: () => onAction(u, "resetpw"),
              disabled: busyId === u.id,
            },
            ...(u.has_2fa ? [{
              label: t("saUsers.reset2fa"),
              onClick: () => onAction(u, "reset2fa"),
              disabled: busyId === u.id,
            }] : []),
            {
              label: t("saUsers.viewAs"),
              onClick: () => onAction(u, "view"),
              disabled: busyId === u.id,
            },
            {
              label: t("saUsers.impersonate"),
              onClick: () => onAction(u, "impersonate"),
              disabled: busyId === u.id,
            },
            {
              label: t("saUsers.titleRevoke"),
              onClick: () => onAction(u, "revokesessions"),
              disabled: busyId === u.id,
            },
          ]}
        />
      )),
    },
  ];
}


/** Inline create form for a store-less "support" platform login —
 *  tickets-only role, password sign-in with a 7-day login window.
 *  The role is fixed server-side (POST /superadmin/platform-users
 *  only mints support). */
function AddSupportLoginCard({ onCreated }: { onCreated: () => void }) {
  const t = useT();
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
        message: t("saUsers.supportCreated", { name: username.trim() }),
        tone: "success",
      });
      onCreated();
    } catch (err) {
      setError(
        apiErrorMessage(err, t("saUsers.createFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit} autoComplete="off">
        <p className={styles.addSupportLead}>
          {t("saUsers.supportLead")}
        </p>
        {error && <Alert tone="error">{error}</Alert>}
        <div className={styles.addSupportGrid}>
          <Field label={t("saUsers.colUsername")}>
            <Input
              value={username} required minLength={3} maxLength={80}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t("saUsers.fullName")}>
            <Input
              value={fullName} maxLength={120}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label={t("common.email")} hint={t("saUsers.emailHint")}>
            <Input
              type="email" value={email} maxLength={255}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label={t("saUsers.password")} hint={t("saUsers.pwHint")}>
            <Input
              type="password" value={password} required
              minLength={8} maxLength={200}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" busy={busy} disabled={busy}>
          {busy ? t("saForm.creating") : t("saUsers.createSupport")}
        </Button>
      </form>
    </Card>
  );
}

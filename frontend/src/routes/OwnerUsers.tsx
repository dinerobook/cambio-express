import { useQuery } from "@tanstack/react-query";

import { RolePill } from "../components/RolePill";
import { roleLabel } from "../api/roles";
import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Card, DataTable, Input, PageHeader, PageShell, Pill,
  type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import type { components } from "../api/openapi";

type UserRow = components["schemas"]["OwnerUserRow"];
type UsersResponse = components["schemas"]["OwnerUserListResponse"];

/** One page of the owner's team list — the request the page and its
 *  CSV export both make. */
function fetchOwnerUsers(storeId: number | null, q: string, page: number, perPage: number) {
  const params = new URLSearchParams();
  if (storeId) params.set("store_id", String(storeId));
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  return api<UsersResponse>(`/api/v2/owner/users?${params}`);
}

function useOwnerUsers(storeId: number | null, q: string, page: number, perPage: number) {
  const identity = getCurrentIdentity();
  return useQuery<UsersResponse>({
    // The server admits the superadmin too, for support.
    enabled: identity?.role === "owner" || identity?.role === "superadmin",
    queryKey: ["owner-users", storeId, q, page, perPage],
    queryFn: () => fetchOwnerUsers(storeId, q, page, perPage),
    placeholderData: (prev) => prev,
  });
}

const COLUMNS: DataColumn<UserRow>[] = [
  { key: "name", header: "Name", render: (u) => <strong>{u.full_name || "—"}</strong>,
    csv: (u) => u.full_name },
  {
    key: "username", header: "Username",
    render: (u) => <span style={{ fontFamily: "var(--db-font-mono)", fontSize: "0.85rem" }}>{u.username}</span>,
    csv: (u) => u.username,
  },
  { key: "role", header: "Role", render: (u) => <RolePill role={u.role} />, csv: (u) => roleLabel(u.role) },
  { key: "store", header: "Store", render: (u) => u.store_name, csv: (u) => u.store_name },
  {
    key: "status", header: "Status",
    render: (u) => (
      <Pill tone={u.is_active ? "accent" : "neutral"}>
        {u.is_active ? "Active" : "Inactive"}
      </Pill>
    ),
    csv: (u) => (u.is_active ? "Active" : "Inactive"),
  },
];

export default function OwnerUsers() {
  const filters = useUrlFilterState({ q: "" }, { pageSizeKey: "owner-users" });
  const { data, isLoading, isError, error, refetch } = useOwnerUsers(
    null, filters.params.q, filters.page, filters.perPage,
  );

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Team users"
        subtitle="Users across all your linked stores"
      />

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
        <Input
          type="search"
          aria-label="Search"
          style={{ width: "16rem", maxWidth: "100%" }}
          placeholder="Search by name or username…"
          value={filters.draft.q ?? filters.params.q}
          onChange={(e) => filters.debounced("q", e.target.value)}
        />
      </div>

      <Card>
        <DataTable
          columns={COLUMNS}
          rows={data?.rows}
          rowKey={(u) => u.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          errorMessage="Could not load users."
          emptyTitle="No users found"
          emptyBody="No matching users across your stores."
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "team-users",
            fetchPage: (p, n) => fetchOwnerUsers(null, filters.params.q, p, n),
          }}
        />
      </Card>
    </PageShell>
  );
}

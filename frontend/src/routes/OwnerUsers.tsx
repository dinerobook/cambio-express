import { useQuery } from "@tanstack/react-query";

import { RolePill } from "../components/RolePill";
import { api } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  Card, DataTable, Input, PageHeader, PageShell, Pill,
  type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";

interface UserRow {
  id: number;
  username: string;
  full_name: string;
  role: string;
  is_active: boolean;
  store_id: number;
  store_name: string;
}

interface UsersResponse {
  rows: UserRow[];
  total: number;
  page: number;
  total_pages: number;
}

function useOwnerUsers(storeId: number | null, q: string, page: number, perPage: number) {
  const identity = getCurrentIdentity();
  const params = new URLSearchParams();
  if (storeId) params.set("store_id", String(storeId));
  if (q) params.set("q", q);
  params.set("page", String(page));
  params.set("per_page", String(perPage));
  return useQuery<UsersResponse>({
    // The server admits the superadmin too, for support.
    enabled: identity?.role === "owner" || identity?.role === "superadmin",
    queryKey: ["owner-users", storeId, q, page, perPage],
    queryFn: () => api<UsersResponse>(`/api/v2/owner/users?${params}`),
    placeholderData: (prev) => prev,
  });
}

const COLUMNS: DataColumn<UserRow>[] = [
  { key: "name", header: "Name", render: (u) => <strong>{u.full_name || "—"}</strong> },
  {
    key: "username", header: "Username",
    render: (u) => <span style={{ fontFamily: "var(--db-font-mono)", fontSize: "0.85rem" }}>{u.username}</span>,
  },
  { key: "role", header: "Role", render: (u) => <RolePill role={u.role} /> },
  { key: "store", header: "Store", render: (u) => u.store_name },
  {
    key: "status", header: "Status",
    render: (u) => (
      <Pill tone={u.is_active ? "accent" : "neutral"}>
        {u.is_active ? "Active" : "Inactive"}
      </Pill>
    ),
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
        />
      </Card>
    </PageShell>
  );
}

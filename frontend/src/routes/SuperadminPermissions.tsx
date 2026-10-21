import { getCurrentIdentity } from "../lib/auth";
import { PageHeader, PageShell } from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { RolePermissionsEditor } from "../components/RolePermissionsEditor";

// The platform defaults every store starts from. The grid, save and
// unsaved-changes bar are the shared RolePermissionsEditor's.
export default function SuperadminPermissions() {
  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Permissions"
        subtitle="Configure what each role can do across the platform"
      />
      <RolePermissionsEditor
        endpoint="/api/v2/superadmin/permissions"
        queryKey={["superadmin", "permissions"]}
        enabled={getCurrentIdentity()?.role === "superadmin"}
      />
    </PageShell>
  );
}

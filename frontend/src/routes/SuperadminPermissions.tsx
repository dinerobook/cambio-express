import { getCurrentIdentity } from "../lib/auth";
import { PageHeader, PageShell } from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { RolePermissionsEditor } from "../components/RolePermissionsEditor";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// The platform defaults every store starts from. The grid, save and
// unsaved-changes bar are the shared RolePermissionsEditor's.
export default function SuperadminPermissions() {
  const t = useT();
  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Permissions")}
        subtitle={t("saPerm.subtitle")}
      />
      <RolePermissionsEditor
        endpoint="/api/v2/superadmin/permissions"
        queryKey={["superadmin", "permissions"]}
        enabled={getCurrentIdentity()?.role === "superadmin"}
      />
    </PageShell>
  );
}

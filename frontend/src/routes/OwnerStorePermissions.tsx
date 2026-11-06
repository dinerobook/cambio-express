import { useParams } from "react-router-dom";

import { PageHeader, PageShell } from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { RolePermissionsEditor } from "../components/RolePermissionsEditor";
import { useT } from "../i18n";

// An owner's view of one store's role grid. The server names the
// roles the owner may change (`editable_roles`); the rest show
// locked. Grid, save, reset and the unsaved bar are the shared
// RolePermissionsEditor's.
export default function OwnerStorePermissions() {
  const { storeId } = useParams<{ storeId: string }>();
  const sid = Number(storeId);
  const t = useT();
  return (
    <PageShell gap="1.25rem">
      <PageCrumbs
        under="/owner/locations"
        via={[{ label: t("owner.storeN", { id: sid }), to: `/owner/store/${sid}` }]}
        current={t("owner.permissionsCrumb")}
      />
      <PageHeader
        title={t("owner.storePermsTitle")}
        subtitle={t("owner.storePermsSubtitle")}
      />
      <RolePermissionsEditor
        endpoint={`/api/v2/owner/store/${sid}/permissions`}
        queryKey={["owner-store-permissions", sid]}
      />
    </PageShell>
  );
}

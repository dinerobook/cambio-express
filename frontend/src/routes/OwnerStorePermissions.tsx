import { useParams } from "react-router-dom";

import { PageHeader, PageShell } from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { RolePermissionsEditor } from "../components/RolePermissionsEditor";

// An owner's view of one store's role grid. The server names the
// roles the owner may change (`editable_roles`); the rest show
// locked. Grid, save, reset and the unsaved bar are the shared
// RolePermissionsEditor's.
export default function OwnerStorePermissions() {
  const { storeId } = useParams<{ storeId: string }>();
  const sid = Number(storeId);
  return (
    <PageShell gap="1.25rem">
      <PageCrumbs under="/owner/locations" via={[{ label: `Store ${sid}`, to: `/owner/store/${sid}` }]} current="Permissions" />
      <PageHeader
        title="Store permissions"
        subtitle="Customize what each role can do in this store"
      />
      <RolePermissionsEditor
        endpoint={`/api/v2/owner/store/${sid}/permissions`}
        queryKey={["owner-store-permissions", sid]}
      />
    </PageShell>
  );
}

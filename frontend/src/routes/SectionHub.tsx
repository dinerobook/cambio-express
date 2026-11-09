import { Navigate, useParams } from "react-router-dom";

import { PageHeader, PageShell } from "../components/ui";
import { NavTileGrid } from "../components/NavTileGrid";
import { filterNavForRole, sectionSlug } from "../components/navConfig";
import { useSessionStatus } from "../api/account";
import { getCurrentIdentity } from "../lib/auth";

// Polished "pick where to go" landing for a nav section.  Renders
// the section's items as a tile grid — the same destinations the
// slim-sidebar fly-out lists, presented as interactive cards for a
// more finished, launcher-style feel.
//
// Single source of truth: reads the SAME role/permission-filtered
// NAV the sidebar uses (navConfig), so a hub can never drift from
// the rail — add an item to NAV and it shows up in both places.
//
// Reached from the fly-out header link (see SlimSidebar) and any
// direct /hub/:key navigation.  `key` is the per-role section slug
// from `sectionSlug(group.title)`.

export default function SectionHub() {
  const { key = "" } = useParams<{ key: string }>();
  const identity = getCurrentIdentity();
  const role = identity?.role ?? "";
  const perms = identity?.permissions ?? [];
  const { data: sessionStatus } = useSessionStatus();

  const groups = filterNavForRole(role, perms, sessionStatus?.features);
  const group = groups.find((g) => sectionSlug(g.title) === key);

  // Unknown / empty section (bad slug, or every item filtered out
  // for this role) → bounce to the role's landing rather than 404,
  // so a stale link never strands the user on a blank page.
  if (!group) return <Navigate to="/dashboard" replace />;

  // Direct-link group (e.g. Reports): there is no tile grid — the
  // section IS a single destination. Forward there so a stale
  // /hub/<slug> link lands on the real page.
  if (group.to) return <Navigate to={group.to} replace />;

  return (
    <PageShell maxWidth="72rem">
      <PageHeader
        title={group.title}
        subtitle="Choose where to go in this section."
      />
      <NavTileGrid
        tiles={group.items.map((item) => ({
          to: item.to, icon: item.icon, label: item.label, desc: item.desc,
        }))}
      />
    </PageShell>
  );
}

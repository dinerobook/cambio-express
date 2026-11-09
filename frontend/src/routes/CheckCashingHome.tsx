import { useSessionStatus } from "../api/account";
import { NavTileGrid, type NavTile } from "../components/NavTileGrid";
import { CHECK_HOME, filterNavForRole } from "../components/navConfig";
import { Card, Empty, PageHeader, PageShell, SectionTitle } from "../components/ui";
import { navWord } from "../i18n/navWords";
import { useT, type MessageKey } from "../i18n";
import { getCurrentIdentity } from "../lib/auth";
import styles from "./CheckCashing.module.css";

// Check cashing → Home (/app/check-cashing): where the check cashing
// app opens (navConfig "Workspaces"). The pages of the app as tiles,
// and what comes next. Rules: api/Modules/CheckCashing/INVARIANTS.md.

const TILE_DESC: Record<string, MessageKey> = {
  "/check-cashing/customers": "checkCashing.tileCustomers",
  "/check-cashing/companies": "checkCashing.tileCompanies",
  "/check-cashing/settings": "checkCashing.tileSettings",
};

export default function CheckCashingHome() {
  const t = useT();
  const identity = getCurrentIdentity();
  const { data: session } = useSessionStatus();
  const title = navWord("Check cashing");

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title={title} />
        <Empty>{t("checkCashing.signIn")}</Empty>
      </PageShell>
    );
  }

  const tiles: NavTile[] = filterNavForRole(
    identity.role, identity.permissions, session?.features, "checks",
  )
    .filter((g) => g.to && g.to !== CHECK_HOME)
    .map((g) => ({
      to: g.to!,
      icon: g.icon,
      label: navWord(g.title),
      desc: TILE_DESC[g.to!] ? t(TILE_DESC[g.to!]) : undefined,
    }));

  return (
    <PageShell maxWidth="72rem">
      <PageHeader title={title} subtitle={t("checkCashing.homeSubtitle")} />
      <Card className={styles.search}>
        <SectionTitle>{t("checkCashing.cashTitle")}</SectionTitle>
        <p className={styles.note}>{t("checkCashing.cashComing")}</p>
      </Card>
      <NavTileGrid tiles={tiles} />
    </PageShell>
  );
}


import { useOwnerLocations } from "../api/owner";
import { useProfile } from "../api/account";
import { AppLink,
  Card, KpiCard, KpiGrid, Loading, PageHeader, PageShell,
  Pill, SectionTitle,
  ErrorState,
  Empty,
} from "../components/ui";
import styles from "./OwnerSettings.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, tNodes, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// The owner's shortcuts and what each is for. Built during render
// so the words follow a language switch; sidebar pages keep their
// sidebar name (navWord).
const quickLinks = (): Array<{ to: string; title: string; desc: MessageKey }> => [
  { to: "/owner/locations", title: navWord("Locations"), desc: "owner.qLocationsDesc" },
  { to: "/owner/connect", title: t("owner.qConnect"), desc: "owner.qConnectDesc" },
  { to: "/owner/users", title: navWord("Team users"), desc: "owner.qUsersDesc" },
  { to: "/owner/bulk-add-user", title: t("owner.qBulkAdd"), desc: "owner.qBulkAddDesc" },
  { to: "/owner/cross-store-defaults", title: navWord("Cross-store defaults"), desc: "owner.qDefaultsDesc" },
  { to: "/owner/activity", title: navWord("Activity stream"), desc: "owner.qActivityDesc" },
  { to: "/owner/bulk-permissions", title: navWord("Bulk permissions"), desc: "owner.qBulkPermsDesc" },
  { to: "/account/notifications", title: navWord("Notifications"), desc: "owner.qNotificationsDesc" },
];

export default function OwnerSettings() {
  useT(); // re-render on a language switch
  const { data: profile } = useProfile();
  const { data: locations, isLoading, isError, refetch } = useOwnerLocations("month");

  const storeCount = locations?.rows.length ?? 0;

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Owner settings")}
        subtitle={t("owner.settingsSubtitle")}
      />

      <KpiGrid>
        <KpiCard label={t("owner.linkedStores")} value={storeCount} />
        <KpiCard label={t("owner.account")} value={profile?.full_name || profile?.username || "—"} />
        <KpiCard label={t("owner.role")} value={t("owner.roleOwner")} />
      </KpiGrid>

      <Card>
        <SectionTitle>{t("owner.profile")}</SectionTitle>
        <div className={styles.profileGrid}>
          <span className={styles.muted}>{t("owner.username")}</span>
          <span>{profile?.username ?? "—"}</span>
          <span className={styles.muted}>{t("owner.fullName")}</span>
          <span>{profile?.full_name || "—"}</span>
          <span className={styles.muted}>{t("owner.email")}</span>
          <span>{profile?.email || "—"}</span>
          <span className={styles.muted}>{t("owner.phone")}</span>
          <span>{profile?.phone || "—"}</span>
        </div>
        <div className={styles.editRow}>
          <AppLink to="/settings/profile" className={styles.editLink}>
            {t("owner.editProfile")}
          </AppLink>
        </div>
      </Card>

      <Card>
        <SectionTitle>{t("owner.quickActions")}</SectionTitle>
        <div className={styles.quickGrid}>
          {quickLinks().map((q) => (
            <QuickLink key={q.to} to={q.to} title={q.title} desc={t(q.desc)} />
          ))}
        </div>
      </Card>

      {locations && (
        <Card>
          <SectionTitle>{t("owner.linkedStores")}</SectionTitle>
          <div className={styles.storeList}>
            {locations.rows.map((s) => (
              <AppLink
                key={s.store_id}
                to={`/owner/store/${s.store_id}`}
                className={styles.storeRow}
              >
                <span className={styles.storeName}>{s.store_name}</span>
                <Pill tone="accent">{tn("owner.storeTransfers", s.transfer_count)}</Pill>
              </AppLink>
            ))}
            {storeCount === 0 && (
              <Empty>
                {tNodes("owner.noStoresConnect", {
                  link: (
                    <AppLink to="/owner/connect" className={styles.emptyLink}>
                      {t("owner.generateCode")}
                    </AppLink>
                  ),
                })}
              </Empty>
            )}
          </div>
        </Card>
      )}

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("owner.storesLoadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}
    </PageShell>
  );
}

function QuickLink({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <AppLink to={to} className={styles.quickLink}>
      <div className={styles.quickTitle}>{title}</div>
      <div className={styles.quickDesc}>{desc}</div>
    </AppLink>
  );
}

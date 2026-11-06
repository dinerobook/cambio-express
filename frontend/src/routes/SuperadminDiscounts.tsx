import { useQueryClient } from "@tanstack/react-query";

import {
  useDiscounts,
  toggleDiscount,
  type DiscountCodeRow,
} from "../api/featureFlags";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { formatDate } from "../lib/datetime";
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  PageShell,
  Pill,
  useToast,
  type DataColumn,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import styles from "./SuperadminDiscounts.module.css";
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

/** Stripe's duration words; one Stripe adds later shows as sent. */
const DURATION: Record<string, MessageKey> = {
  once: "saDisc.duration.once",
  forever: "saDisc.duration.forever",
  repeating: "saDisc.duration.repeating",
};

export default function SuperadminDiscounts() {
  const t = useT();
  const { data, isLoading, isError, error, refetch } = useDiscounts();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();

  async function handleToggle(row: DiscountCodeRow) {
    try {
      await toggleDiscount(row.id, !row.is_active);
      void qc.invalidateQueries({ queryKey: ["superadmin-discounts"] });
      toast({
        message: t(row.is_active ? "saDisc.toggledOff" : "saDisc.toggledOn", { code: row.code }),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("saDisc.toggleFailed"));
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Discounts")}
        subtitle={t("saDisc.subtitle")}
      />

      <Card>
        <DataTable
          columns={discountColumns(handleToggle)}
          rows={data?.rows}
          rowKey={(row) => row.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          errorMessage={t("saDisc.loadFailed")}
          emptyTitle={t("saDisc.emptyTitle")}
          emptyBody={t("saDisc.emptyBody")}
          page={data && {
            page: 1, totalPages: 1, total: data.total, onPage: () => {},
            leading: (
              <span className={styles.note}>
                {t("saDisc.stripeNote")}
              </span>
            ),
          }}
        />
      </Card>
    </PageShell>
  );
}

/** The Stripe coupon list as the kit ``<DataTable>``. */
function discountColumns(
  onToggle: (row: DiscountCodeRow) => Promise<void>,
): DataColumn<DiscountCodeRow>[] {
  const t = translate;
  return [
    { key: "code", header: t("saDisc.colCode"), render: (r) => <span className={styles.code}>{r.code}</span> },
    { key: "value", header: t("saDisc.colValue"), render: (r) => r.value_label },
    {
      key: "duration", header: t("saDisc.colDuration"),
      render: (r) => (
        <span className={styles.small}>
          {r.duration === "repeating" && r.duration_in_months
            ? tn("saDisc.months", r.duration_in_months)
            : Object.hasOwn(DURATION, r.duration) ? t(DURATION[r.duration]) : r.duration}
        </span>
      ),
    },
    {
      key: "redeemed", header: t("saDisc.colRedeemed"),
      render: (r) => (
        <span className={styles.mono}>
          {r.redeemed_count}
          {r.max_redemptions != null && (
            <span className={styles.muted}>{" "}/ {r.max_redemptions}</span>
          )}
        </span>
      ),
    },
    {
      key: "expires", header: t("saDisc.colExpires"),
      render: (r) => <span className={styles.expires}>{formatDate(r.expires_at)}</span>,
    },
    {
      key: "status", header: t("common.status"),
      render: (r) => (r.is_redeemable ? (
        <Pill tone="accent">{t("saDisc.redeemable")}</Pill>
      ) : r.is_active ? (
        <Pill tone="warning">{t("saDisc.capped")}</Pill>
      ) : (
        <Pill tone="neutral">{t("saDisc.disabled")}</Pill>
      )),
    },
    {
      key: "actions", header: t("common.actions"), label: "", align: "right",
      render: (r) => (
        <Button size="sm" tone="secondary" onClick={() => { void onToggle(r); }}>
          {r.is_active ? t("saDisc.disable") : t("saDisc.enable")}
        </Button>
      ),
    },
  ];
}

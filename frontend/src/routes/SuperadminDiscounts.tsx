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

export default function SuperadminDiscounts() {
  const { data, isLoading, isError, error, refetch } = useDiscounts();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();

  async function handleToggle(row: DiscountCodeRow) {
    try {
      await toggleDiscount(row.id, !row.is_active);
      void qc.invalidateQueries({ queryKey: ["superadmin-discounts"] });
      toast({
        message: `${row.code} → ${!row.is_active ? "active" : "disabled"}`,
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, "Toggle failed");
    }
  }

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title="Discounts"
        subtitle="Stripe coupon codes — toggle visibility, view redemptions"
      />

      <Card>
        <DataTable
          columns={discountColumns(handleToggle)}
          rows={data?.rows}
          rowKey={(row) => row.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          errorMessage="Could not load discount codes."
          emptyTitle="No discount codes"
          emptyBody="Coupon codes created in Stripe will appear here."
          page={data && {
            page: 1, totalPages: 1, total: data.total, onPage: () => {},
            leading: (
              <span className={styles.note}>
                Coupon creation is managed in the Stripe Dashboard.
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
  return [
    { key: "code", header: "Code", render: (r) => <span className={styles.code}>{r.code}</span> },
    { key: "value", header: "Value", render: (r) => r.value_label },
    {
      key: "duration", header: "Duration",
      render: (r) => (
        <span className={styles.small}>
          {r.duration === "repeating" && r.duration_in_months
            ? `${r.duration_in_months} mo`
            : r.duration}
        </span>
      ),
    },
    {
      key: "redeemed", header: "Redeemed",
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
      key: "expires", header: "Expires",
      render: (r) => <span className={styles.expires}>{formatDate(r.expires_at)}</span>,
    },
    {
      key: "status", header: "Status",
      render: (r) => (r.is_redeemable ? (
        <Pill tone="accent">Redeemable</Pill>
      ) : r.is_active ? (
        <Pill tone="warning">Capped / expired</Pill>
      ) : (
        <Pill tone="neutral">Disabled</Pill>
      )),
    },
    {
      key: "actions", header: "Actions", label: "", align: "right",
      render: (r) => (
        <Button size="sm" tone="secondary" onClick={() => { void onToggle(r); }}>
          {r.is_active ? "Disable" : "Enable"}
        </Button>
      ),
    },
  ];
}

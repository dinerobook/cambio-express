import { useState } from "react";

import TransferForm from "../components/TransferForm";
import { Alert, PageHeader, PageShell, tokens } from "../components/ui";
import { getOpenStatus, weekdayNameLong } from "../lib/datetime";
import { createTransfer } from "../api/transfers";
import { useStoreInfo } from "../api/account";
import { newIdempotencyKey } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { newTransferValues } from "../lib/transferForm";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// New transfer at /app/transfers/new. The fields, the store's lists,
// the guard and the save flow are the shared `TransferForm` (one form
// with EditTransfer); this page adds the title, the out-of-hours
// notice and the save-once key.

export default function NewTransfer() {
  const t = useT();
  const identity = getCurrentIdentity();
  const storeInfo = useStoreInfo();
  // Dated when the form opens, never when the app loaded.
  const [initialValues] = useState(newTransferValues);

  // One key for this form, sent on every save attempt. If a save
  // landed but its response did not (dropped connection, an error
  // after the commit), pressing Save again returns that transfer
  // instead of logging the money a second time.
  const [saveKey] = useState(newIdempotencyKey);

  if (identity?.store_id == null) {
    return (
      <PageShell>
        <PageHeader title={t("transfer.newTitle")} />
        <p style={{ color: tokens.textMuted, textAlign: "center", padding: "1.5rem 0" }}>
          {t("transfer.newSignIn")}
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageCrumbs current={t("transfer.newTitle")} />
      <PageHeader
        title={t("transfer.newTitle")}
        subtitle={t("transfer.newSubtitle")}
      />

      <OutOfHoursNotice
        hours={storeInfo.data?.store?.store_hours}
        storeTimezone={storeInfo.data?.store?.timezone}
      />

      <TransferForm
        initialValues={initialValues}
        startOnStoreLists
        storeId={identity.store_id}
        submitLabel={t("transfer.saveTransfer")}
        cancelTo="/transfers"
        savedMessage={t("transfer.saved")}
        failedMessage={t("transfer.saveFailed")}
        save={(values) => createTransfer(values, saveKey)}
      />
    </PageShell>
  );
}


// Soft warning above the New Transfer form when the operator is
// logging outside the store's configured business hours. Not a
// gate — the save endpoint still accepts the entry. Hidden when
// store_hours is missing (no opinion to express) or when we're
// currently inside the open window.
function OutOfHoursNotice({
  hours, storeTimezone,
}: {
  hours: NonNullable<ReturnType<typeof useStoreInfo>["data"]>["store"]["store_hours"] | undefined;
  storeTimezone: string | undefined;
}) {
  const t = useT();
  const status = getOpenStatus(hours, storeTimezone);
  if (!status || status.open) return null;
  const day = weekdayNameLong(status.dayIndex);
  return (
    <Alert tone="warning">
      {t("transfer.outOfHours", {
        hours: status.todayLabel
          ? t("transfer.outOfHoursOpen", { day, hours: status.todayLabel })
          : t("transfer.outOfHoursClosed", { day }),
      })}
    </Alert>
  );
}

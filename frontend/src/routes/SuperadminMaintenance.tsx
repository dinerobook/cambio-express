import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, Button, Card, ErrorState, Field, FormActions, Input,
  Loading, PageHeader, PageShell, SectionTitle, Switch, useToast,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./SuperadminMaintenance.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import type { components } from "../api/openapi";
import { useT } from "../i18n";
import { navWord } from "../i18n/navWords";

type MaintenanceState = components["schemas"]["MaintenanceState"];

function useMaintenanceState() {
  const identity = getCurrentIdentity();
  return useQuery<MaintenanceState>({
    enabled: identity?.role === "superadmin",
    queryKey: ["superadmin", "maintenance"],
    queryFn: () => api<MaintenanceState>("/api/v2/superadmin/maintenance"),
  });
}

export default function SuperadminMaintenance() {
  const t = useT();
  const { data, isLoading, isError, error: loadError, refetch } = useMaintenanceState();
  const qc = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local toggle state from server-fetched maintenance config
      setEnabled(data.enabled);
      setMessage(data.message);
      setHydrated(true);
    }
  }, [data]);

  const { dirty, markSaved } = useDirtyBaseline({ enabled, message }, hydrated);
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("saMaint.unsaved"),
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v2/superadmin/maintenance", {
        method: "POST",
        json: { enabled, message: message.trim() },
      });
      markSaved();
      qc.invalidateQueries({ queryKey: ["superadmin", "maintenance"] });
      toast({
        message: enabled
          ? t("saMaint.onToast")
          : t("saMaint.offToast"),
        tone: enabled ? "warning" : "success",
      });
    } catch (err) {
      setError(apiErrorMessage(err, t("saMaint.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="48rem" gap="1.25rem">
      <PageCrumbs />

      <PageHeader
        title={navWord("Maintenance")}
        subtitle={t("saMaint.subtitle")}
      />

      {isLoading && <Loading />}

      {isError && (
        // No form without the real state: saving defaults would
        // switch a live maintenance window off and wipe its message.
        <ErrorState
          message={apiErrorMessage(loadError, t("saMaint.loadFailed"))}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && (
        <Card>
          <div className={styles.toggleCard}>
            <SectionTitle>{t("saMaint.status")}</SectionTitle>

            <div className={styles.statusRow}>
              <div>
                <span className={enabled ? styles.dotOn : styles.dotOff} />
                <span className={styles.statusLabel}>
                  {enabled ? t("saMaint.isOn") : t("saMaint.isOff")}
                </span>
              </div>
              <Switch
                checked={enabled}
                onChange={setEnabled}
              >
                {enabled ? t("saMaint.on") : t("saMaint.off")}
              </Switch>
            </div>

            <Field
              label={t("saMaint.message")}
              hint={t("saMaint.messageHint")}
            >
              <Input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("saMaint.placeholder")}
                maxLength={500}
                className={styles.messageInput}
              />
            </Field>

            {enabled && message && (
              <div className={styles.preview}>
                {message}
              </div>
            )}

            {error && <Alert tone="error">{error}</Alert>}

            <FormActions guard={guard}>
              <Button onClick={() => { void save(); }} busy={busy} disabled={busy}>
                {busy ? t("common.saving") : t("common.save")}
              </Button>
            </FormActions>
          </div>
        </Card>
      )}
    </PageShell>
  );
}

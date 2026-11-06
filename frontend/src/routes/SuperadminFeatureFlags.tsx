import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useFeatureFlags,
  useStoreOverrides,
  createFeatureFlag,
  toggleFeatureFlag,
  deleteFeatureFlag,
  setStoreOverride,
  clearStoreOverride,
  type FeatureFlagRow,
  type StoreOverrideRow,
} from "../api/featureFlags";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import {
  Alert, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorState,
  Field, FormActions, Input, Loading, PageHeader, PageShell, Pill,
  RowActions, Table, Textarea, useToast,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import { formatDate } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// A sample flag key: keys are code, the same in every language.
const KEY_SAMPLE = "addon_my_feature";

export default function SuperadminFeatureFlags() {
  const t = useT();
  const { data, isLoading, isError, refetch } = useFeatureFlags();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <PageShell gap="1.25rem">
      <PageCrumbs />
      <PageHeader
        title={navWord("Feature flags")}
        subtitle={t("saFlags.subtitle")}
        actions={
          <Button onClick={() => setCreating(true)} disabled={creating}>
            {t("saFlags.new")}
          </Button>
        }
      />

      {creating && (
        <CreateFlagForm
          onDone={() => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ["feature-flags"] });
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("saFlags.loadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {data && data.rows.length === 0 && !creating && (
        <EmptyState
          title={t("saFlags.emptyTitle")}
          body={t("saFlags.emptyBody")}
        />
      )}

      {data && data.rows.length > 0 && (
        <Card>
          <Table>
            <thead>
              <tr>
                <th>{t("saFlags.colKey")}</th>
                <th>{t("saFlags.colLabel")}</th>
                <th>{t("saFlags.colDefault")}</th>
                <th>{t("saFlags.colCreated")}</th>
                <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((flag) => (
                <FlagRow
                  key={flag.id}
                  flag={flag}
                  expanded={expandedKey === flag.key}
                  onToggleExpand={() =>
                    setExpandedKey(expandedKey === flag.key ? null : flag.key)
                  }
                  onRefresh={() =>
                    void qc.invalidateQueries({ queryKey: ["feature-flags"] })
                  }
                />
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </PageShell>
  );
}

function FlagRow({
  flag,
  expanded,
  onToggleExpand,
  onRefresh,
}: {
  flag: FeatureFlagRow;
  expanded: boolean;
  onToggleExpand: () => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleToggle() {
    setBusy(true);
    try {
      await toggleFeatureFlag(flag.key, !flag.enabled_by_default);
      onRefresh();
      toast({
        message: t(flag.enabled_by_default ? "saFlags.toggledOff" : "saFlags.toggledOn", { key: flag.key }),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("saFlags.toggleFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await deleteFeatureFlag(flag.key);
      onRefresh();
      toast({ message: t("saFlags.deleted", { key: flag.key }), tone: "success" });
    } catch (err) {
      toastApiError(err, t("saFlags.deleteFailed"));
    } finally {
      setBusy(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <>
      <tr>
        <td style={{ fontFamily: "var(--db-font-mono)", fontSize: "0.85rem" }}>
          {flag.key}
        </td>
        <td>{flag.label || <span style={{ color: "var(--db-text-muted)" }}>—</span>}</td>
        <td>
          <Pill tone={flag.enabled_by_default ? "accent" : "neutral"}>
            {flag.enabled_by_default ? t("saFlags.on") : t("saFlags.off")}
          </Pill>
        </td>
        <td style={{ fontSize: "0.82rem", color: "var(--db-text-muted)" }}>
          {formatDate(flag.created_at)}
        </td>
        <td style={{ textAlign: "right" }}>
          <RowActions
            title={flag.key}
            actions={[
              {
                label: flag.enabled_by_default ? t("saFlags.disable") : t("saFlags.enable"),
                onClick: handleToggle, disabled: busy,
              },
              {
                label: expanded ? t("saFlags.hideOverrides") : t("saFlags.overrides"),
                onClick: onToggleExpand,
              },
              {
                label: t("common.delete"), tone: "danger",
                onClick: () => setConfirmingDelete(true),
                disabled: busy,
              },
            ]}
          />
          <ConfirmDialog
            open={confirmingDelete}
            title={t("saFlags.deleteTitle")}
            message={t("saFlags.deleteBody", { key: flag.key })}
            confirmLabel={t("common.delete")}
            confirmTone="danger"
            busy={busy}
            onConfirm={() => { void handleDelete(); }}
            onCancel={() => setConfirmingDelete(false)}
          />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ padding: 0 }}>
            <OverridesPanel flagKey={flag.key} />
          </td>
        </tr>
      )}
    </>
  );
}

function OverridesPanel({ flagKey }: { flagKey: string }) {
  const t = useT();
  const { data, isLoading } = useStoreOverrides(flagKey);
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [addStoreId, setAddStoreId] = useState("");

  async function handleSet(storeId: number, enabled: boolean) {
    try {
      await setStoreOverride(flagKey, storeId, enabled);
      void qc.invalidateQueries({ queryKey: ["feature-flag-overrides", flagKey] });
      toast({
        message: t("saFlags.overrideSet", {
          id: storeId, state: enabled ? t("saFlags.on") : t("saFlags.off"),
        }),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("saFlags.failed"));
    }
  }

  async function handleClear(storeId: number) {
    try {
      await clearStoreOverride(flagKey, storeId);
      void qc.invalidateQueries({ queryKey: ["feature-flag-overrides", flagKey] });
      toast({ message: t("saFlags.overrideCleared", { id: storeId }), tone: "success" });
    } catch (err) {
      toastApiError(err, t("saFlags.failed"));
    }
  }

  async function handleAdd() {
    const sid = parseInt(addStoreId, 10);
    if (!sid || sid < 1) return;
    await handleSet(sid, true);
    setAddStoreId("");
  }

  return (
    <div style={{ padding: "1rem 1.5rem", background: "var(--db-surface-2)" }}>
      <div style={{ fontWeight: 600, fontSize: "0.85rem", marginBottom: "0.5rem" }}>
        {tNodes("saFlags.overridesFor", { key: <code>{flagKey}</code> })}
      </div>
      {isLoading && <Loading />}
      {data && data.rows.length === 0 && (
        <div style={{ fontSize: "0.82rem", color: "var(--db-text-muted)", marginBottom: "0.5rem" }}>
          {t("saFlags.noOverrides")}
        </div>
      )}
      {data && data.rows.length > 0 && (
        <div style={{ marginBottom: "0.75rem" }}>
          <Table style={{ fontSize: "0.85rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>{t("saFlags.colStore")}</th>
                <th>{t("saFlags.colOverride")}</th>
                <th style={{ textAlign: "right" }}>{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((o: StoreOverrideRow) => (
                <tr key={o.store_id}>
                  <td>{o.store_name} <span style={{ color: "var(--db-text-muted)" }}>({o.store_slug})</span></td>
                  <td>
                    <Pill tone={o.enabled ? "accent" : "neutral"}>
                      {o.enabled ? t("saFlags.on") : t("saFlags.off")}
                    </Pill>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <RowActions
                      title={`${o.store_name} (${o.store_slug})`}
                      actions={[
                        {
                          label: t("saFlags.flip"),
                          onClick: () => handleSet(o.store_id, !o.enabled),
                        },
                        {
                          label: t("saFlags.clear"), tone: "danger",
                          onClick: () => handleClear(o.store_id),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <Input
          style={{ width: "8rem" }}
          type="number"
          min={1}
          placeholder={t("saFlags.storeId")}
          value={addStoreId}
          onChange={(e) => setAddStoreId(e.target.value)}
        />
        <Button size="sm" onClick={() => { void handleAdd(); }}>
          {t("saFlags.addOverride")}
        </Button>
      </div>
    </div>
  );
}

function CreateFlagForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { dirty } = useDirtyBaseline({ key, label, description, enabled });
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("saFlags.unsaved"),
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createFeatureFlag({
        key: key.trim(),
        label: label.trim() || undefined,
        description: description.trim() || undefined,
        enabled_by_default: enabled,
      });
      toast({ message: t("saFlags.created", { key }), tone: "success" });
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("saFlags.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div style={{ fontWeight: 600 }}>{t("saFlags.formTitle")}</div>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t("saFlags.colKey")} hint={t("saFlags.keyHint")}>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            pattern="^[a-z0-9_]+$"
            required
            placeholder={KEY_SAMPLE}
          />
        </Field>
        <Field label={t("saFlags.colLabel")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("saFlags.labelPlaceholder")} />
        </Field>
        <Field label={t("saFlags.description")}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <Checkbox checked={enabled} onChange={setEnabled}>
          {t("saFlags.enabledDefault")}
        </Checkbox>
        <FormActions guard={guard}>
          <Button
            tone="secondary" type="button"
            onClick={() => guard.confirmLeave(onCancel)}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy}>{t("saFlags.create")}</Button>
        </FormActions>
      </form>
    </Card>
  );
}

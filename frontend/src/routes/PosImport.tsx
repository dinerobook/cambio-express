import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useDepartments } from "../api/dayclose";
import {
  commitNaxml, commitStagedDay, fileToBase64, issueAgentKey,
  previewNaxml, revokeAgentKey, saveMappings, useAgentKeys,
  useStagedDays,
  type ImportRegisterRow, type NaxmlPreview,
} from "../api/posimport";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import {
  formatDate, formatDateTime,
} from "../lib/datetime";
import { AppLink,
  Alert, Button, Card, ConfirmDialog, EmptyState, Field, InfoTip,
  Input, KpiCard, KpiGrid, PageHeader, PageShell, Pill, Section,
  Select, Table, tdStyle, thStyle, useToast,
} from "../components/ui";
import styles from "./PosImport.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { tn, tNodes, useT, type MessageKey } from "../i18n";

const REGISTER_COLUMNS: MessageKey[] = [
  "rc.colRegister", "posImp.netSales", "rc.colTax", "rc.colCash", "rc.colCard",
  "rc.colOther", "posImp.colSales", "posImp.colRefunds",
];
const STAGED_COLUMNS: MessageKey[] = ["posImp.businessDay", "posImp.colFiles", "posImp.colErrors", "common.status"];
const KEY_COLUMNS: MessageKey[] = ["posImp.colLabel", "posImp.colCreated", "posImp.colLastSeen", "common.status"];

/**
 * Gilbarco register import (P1-9): upload a day's (or a whole
 * folder's zip of) NAXML journal files, review the per-register
 * aggregates, map the register's numeric department codes onto
 * this store's own departments, and book one business day into
 * the store daily book. Until the site agent ships, the operator
 * grabs the files from the register's back-office share.
 */
export default function PosImport() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const departments = useDepartments();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState("");   // base64, reused for commit
  const [preview, setPreview] = useState<NaxmlPreview | null>(null);
  const [selectedDay, setSelectedDay] = useState("");
  const [draftMap, setDraftMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "preview" | "map" | "commit">("");
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);

  async function runPreview(b64: string) {
    setBusy("preview");
    setError(null);
    try {
      const data = await previewNaxml(b64);
      setPreview(data);
      setSelectedDay((prev) =>
        data.business_dates.includes(prev)
          ? prev
          : data.business_dates[data.business_dates.length - 1] ?? "",
      );
      setDraftMap({});
    } catch (err) {
      setPreview(null);
      setError(apiErrorMessage(err, t("posImp.parseFailed")));
    } finally {
      setBusy("");
    }
  }

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setCommitted(null);
    const b64 = await fileToBase64(file);
    setPayload(b64);
    await runPreview(b64);
  }

  async function onSaveMappings() {
    const rows = Object.entries(draftMap)
      .filter(([, deptId]) => deptId !== "")
      .map(([code, deptId]) => ({
        merchandise_code: code, department_id: Number(deptId),
      }));
    if (rows.length === 0) return;
    setBusy("map");
    setError(null);
    try {
      await saveMappings(rows);
      toast({ message: t("posImp.mappingsSaved"), tone: "success" });
      await runPreview(payload);   // refresh mapped/unmapped state
    } catch (err) {
      setError(apiErrorMessage(err, t("posImp.mappingsFailed")));
    } finally {
      setBusy("");
    }
  }

  async function onCommit() {
    if (!selectedDay) return;
    setBusy("commit");
    setError(null);
    try {
      const result = await commitNaxml(payload, selectedDay);
      setCommitted(
        tn("posImp.committed", result.closes_written, String, {
          day: result.day, registers: result.registers.join(", "),
        }),
      );
      void qc.invalidateQueries({ queryKey: ["dayclose"] });
      toast({
        message: t("posImp.imported"),
        tone: "success",
      });
    } catch (err) {
      setError(apiErrorMessage(err, t("posImp.importFailed")));
    } finally {
      setBusy("");
    }
  }

  const dayRegisters: ImportRegisterRow[] = useMemo(
    () => (preview?.registers ?? []).filter(
      (r) => r.business_date === selectedDay,
    ),
    [preview, selectedDay],
  );
  const dayTotals = useMemo(() => {
    let net = 0, tax = 0, fuelGallons = 0;
    for (const r of dayRegisters) {
      net += r.net_sales;
      tax += r.sales_tax;
      for (const f of r.fuel) fuelGallons += f.gallons;
    }
    return { net, tax, fuelGallons };
  }, [dayRegisters]);

  const unmapped = preview?.unmapped_codes ?? [];

  return (
    <PageShell maxWidth="64rem">
      <PageCrumbs under="/store-book" current={t("posImp.title")} />
      <PageHeader
        title={
          <>
            {t("posImp.title")}
            <InfoTip text={t("posImp.tip")} />
          </>
        }
        subtitle={t("posImp.subtitle")}
      />

      <Section title={t("posImp.step1")}>
        <div className={styles.uploadRow}>
          <input
            ref={fileRef}
            type="file"
            accept=".xml,.zip"
            hidden
            onChange={(e) => { void onPickFile(e.target.files?.[0]); }}
          />
          <Button
            busy={busy === "preview"} disabled={busy !== ""}
            onClick={() => fileRef.current?.click()}
          >
            {t("posImp.choose")}
          </Button>
          {fileName && <span className={styles.fileName}>{fileName}</span>}
          {preview && (
            <Pill tone="neutral">
              {tn("posImp.events", preview.event_count, String, {
                files: tn("posImp.files", preview.file_count),
              })}
            </Pill>
          )}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        {preview && preview.parse_errors.length > 0 && (
          <Alert tone="warning">
            {tn("posImp.parseErrors", preview.parse_errors.length)}
            <div className={styles.parseErrors}>
              {preview.parse_errors.map((e) => <div key={e}>{e}</div>)}
            </div>
          </Alert>
        )}
      </Section>

      {preview && (
        <Section
          title={t("posImp.step2")}
          actions={
            unmapped.length > 0 ? (
              <Button
                size="sm" busy={busy === "map"}
                disabled={busy !== "" || Object.values(draftMap)
                  .filter(Boolean).length === 0}
                onClick={() => { void onSaveMappings(); }}
              >
                {t("posImp.saveMappings")}
              </Button>
            ) : undefined
          }
        >
          {unmapped.length === 0 ? (
            <Alert tone="success">
              {t("posImp.allMapped")}
            </Alert>
          ) : (
            <Card>
              <div className={styles.mapList}>
                {unmapped.map((code) => (
                  <div key={code} className={styles.mapRow}>
                    <span className={styles.mapCode}>
                      {t("posImp.code", { code })}
                      {code === "1024" ? t("posImp.fuel") : ""}
                    </span>
                    <Select
                      className={styles.mapSelect}
                      aria-label={t("posImp.deptFor", { code })}
                      value={draftMap[code] ?? ""}
                      onChange={(e) =>
                        setDraftMap((prev) => ({
                          ...prev, [code]: e.target.value,
                        }))
                      }
                    >
                      <option value="">{t("posImp.pickDept")}</option>
                      {(departments.data?.departments ?? []).map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {unmapped.length > 0
            && (departments.data?.departments ?? []).length === 0 && (
            <EmptyState
              title={t("posImp.noDepts")}
              body={
                <>
                  {tNodes("posImp.noDeptsBody", {
                    link: <AppLink fallback="text" to="/price-book">{t("posImp.deptsTab")}</AppLink>,
                  })}
                </>
              }
            />
          )}
        </Section>
      )}

      {preview && (
        <Section
          title={t("posImp.step3")}
          actions={
            <div className={styles.commitRow}>
              <Field label={t("posImp.businessDay")}>
                <Select
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value)}
                >
                  {preview.business_dates.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </Select>
              </Field>
              <Button
                busy={busy === "commit"}
                disabled={busy !== "" || !selectedDay || unmapped.length > 0}
                onClick={() => { void onCommit(); }}
              >
                {t("posImp.importDay")}
              </Button>
            </div>
          }
        >
          {committed && (
            <Alert tone="success">
              {committed} <AppLink fallback="text" to="/store-book">{t("posImp.openBook")}</AppLink>
            </Alert>
          )}
          {unmapped.length > 0 && (
            <Alert tone="warning">
              {t("posImp.mapFirst")}
            </Alert>
          )}
          {dayRegisters.length > 0 && (
            <>
              <KpiGrid>
                <KpiCard label={t("posImp.netSales")} value={fmtMoney2(dayTotals.net)} />
                <KpiCard label={t("posImp.salesTax")} value={fmtMoney2(dayTotals.tax)} />
                <KpiCard
                  label={t("posImp.fuelGallons")}
                  value={dayTotals.fuelGallons.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                />
                <KpiCard
                  label={t("posImp.registers")}
                  value={String(dayRegisters.length)}
                />
              </KpiGrid>
              <Card>
                <div style={{ overflowX: "auto" }}>
                  <Table>
                    <thead>
                      <tr>
                        {REGISTER_COLUMNS.map((h) => (
                          <th key={h} style={thStyle}>{t(h)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dayRegisters.map((r) => (
                        <tr key={r.register_label}>
                          <td style={tdStyle}>{r.register_label}</td>
                          <td style={tdStyle}>{fmtMoney2(r.net_sales)}</td>
                          <td style={tdStyle}>{fmtMoney2(r.sales_tax)}</td>
                          <td style={tdStyle}>{fmtMoney2(r.cash_total)}</td>
                          <td style={tdStyle}>{fmtMoney2(r.card_total)}</td>
                          <td style={tdStyle}>{fmtMoney2(r.other_total)}</td>
                          <td style={tdStyle}>{r.sale_count}</td>
                          <td style={tdStyle}>{r.refund_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Card>
            </>
          )}
        </Section>
      )}

      <AgentSection />
    </PageShell>
  );
}

// ── Site agent (automatic uploads) ───────────────────────────

function AgentSection() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const staged = useStagedDays();
  const keys = useAgentKeys();
  const [newLabel, setNewLabel] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [busyDay, setBusyDay] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  // The key a revoke is waiting on confirmation for. A revoked key
  // stops the site agent uploading at once, so it is never one click.
  const [revoking, setRevoking] = useState<{ id: number; label: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  async function bookDay(day: string) {
    setBusyDay(day);
    try {
      const result = await commitStagedDay(day);
      toast({
        message: tn("posImp.booked", result.closes_written, String, { day: result.day }),
        tone: "success",
      });
      void qc.invalidateQueries({ queryKey: ["dayclose"] });
      void qc.invalidateQueries({ queryKey: ["posimport", "staged"] });
    } catch (err) {
      toastApiError(err, t("posImp.bookFailed"));
    } finally {
      setBusyDay("");
    }
  }

  async function onIssueKey() {
    setKeyBusy(true);
    try {
      const issued = await issueAgentKey(newLabel.trim());
      setFreshKey(issued.key);
      setNewLabel("");
      void qc.invalidateQueries({ queryKey: ["posimport", "agent-keys"] });
    } catch (err) {
      toastApiError(err, t("posImp.keyFailed"));
    } finally {
      setKeyBusy(false);
    }
  }

  async function onRevoke() {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await revokeAgentKey(revoking.id);
      toast({ message: t("posImp.keyRevoked"), tone: "success" });
      void qc.invalidateQueries({ queryKey: ["posimport", "agent-keys"] });
      setRevoking(null);
    } catch (err) {
      toastApiError(err, t("posImp.revokeFailed"));
    } finally {
      setRevokeBusy(false);
    }
  }

  const stagedRows = staged.data?.days ?? [];
  const keyRows = keys.data?.keys ?? [];

  return (
    <Section
      title={
        <>
          {t("posImp.auto")}
          <InfoTip text={t("posImp.autoTip")} />
        </>
      }
    >
      {stagedRows.length > 0 && (
        <Card>
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  {STAGED_COLUMNS.map(
                    (h) => <th key={h} style={thStyle}>{t(h)}</th>,
                  )}
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {stagedRows.map((d) => (
                  <tr key={d.business_date}>
                    <td style={tdStyle}>{d.business_date}</td>
                    <td style={tdStyle}>{d.file_count}</td>
                    <td style={tdStyle}>{d.error_count || "—"}</td>
                    <td style={tdStyle}>
                      <Pill tone={d.committed ? "success" : "neutral"}>
                        {d.committed ? t("posImp.bookedPill") : t("posImp.ready")}
                      </Pill>
                    </td>
                    <td style={tdStyle}>
                      <Button
                        size="sm"
                        busy={busyDay === d.business_date}
                        disabled={busyDay !== ""}
                        tone={d.committed ? "secondary" : "primary"}
                        onClick={() => { void bookDay(d.business_date); }}
                      >
                        {d.committed ? t("posImp.rebook") : t("posImp.bookDay")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      {staged.data && stagedRows.length === 0 && (
        <EmptyState
          title={t("posImp.noUploads")}
          body={t("posImp.noUploadsBody")}
        />
      )}

      {freshKey && (
        <Alert tone="success">
          {t("posImp.keyCreated")}
          {" "}<code className={styles.mapCode}>{freshKey}</code>
        </Alert>
      )}
      <Card>
        <div className={styles.uploadRow}>
          <Input
            type="text" value={newLabel} maxLength={80}
            placeholder={t("posImp.keyLabel")}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <Button
            size="sm" busy={keyBusy} disabled={keyBusy}
            onClick={() => { void onIssueKey(); }}
          >
            {t("posImp.newKey")}
          </Button>
        </div>
        {keyRows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  {KEY_COLUMNS.map(
                    (h) => <th key={h} style={thStyle}>{t(h)}</th>,
                  )}
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {keyRows.map((k) => (
                  <tr key={k.id}>
                    <td style={tdStyle}>{k.label || "—"}</td>
                    <td style={tdStyle}>{formatDate(k.created_at)}</td>
                    <td style={tdStyle}>
                      {k.last_used_at
                        ? formatDateTime(k.last_used_at)
                        : t("posImp.never")}
                    </td>
                    <td style={tdStyle}>
                      <Pill tone={k.revoked ? "neutral" : "accent"}>
                        {k.revoked ? t("posImp.revoked") : t("posImp.active")}
                      </Pill>
                    </td>
                    <td style={tdStyle}>
                      {!k.revoked && (
                        <Button
                          size="sm" tone="secondary"
                          onClick={() => setRevoking({ id: k.id, label: k.label })}
                        >
                          {t("posImp.revoke")}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={revoking !== null}
        title={t("posImp.revokeTitle")}
        message={t("posImp.revokeMessage", {
          key: revoking?.label ? `"${revoking.label}"` : t("posImp.thisKey"),
        })}
        confirmLabel={t("posImp.revoke")}
        confirmTone="danger"
        busy={revokeBusy}
        onConfirm={() => { void onRevoke(); }}
        onCancel={() => setRevoking(null)}
      />
    </Section>
  );
}

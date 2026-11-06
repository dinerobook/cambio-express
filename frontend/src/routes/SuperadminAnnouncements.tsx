import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  ANNOUNCEMENT_LEVEL_TONES,
  createAnnouncement,
  deleteAnnouncement,
  toggleAnnouncement,
  useAnnouncements,
  type AnnouncementRow,
  type CreateAnnouncementBody,
} from "../api/announcements";
import {
  Alert, Button, Card, Checkbox, ConfirmDialog, Empty, ErrorState, Field,
  FormActions, Input, Loading, PageHeader, PageShell, Pill, SectionTitle,
  Select, Textarea, DataTable, type DataColumn,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import { useSuperadminStores } from "../api/superadmin";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  formatDate, formatDateTime, formatShortDate, parseTimestamp, zonedInputToUtcIso,
} from "../lib/datetime";
import styles from "./SuperadminAnnouncements.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { fmtNumber } from "../lib/formatters";
import { planLabel } from "../api/billing";
import { t as translate, tn, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

// Superadmin-only banner CRUD at /app/superadmin/announcements.
// Mirrors the legacy /superadmin/controls?tab=announcements panel.

const LEVELS: Array<CreateAnnouncementBody["level"]> = [
  "info", "warning", "error", "success",
];

const LEVEL_LABELS: Record<string, MessageKey> = {
  info: "saAnn.lvl.info",
  warning: "saAnn.lvl.warning",
  error: "saAnn.lvl.error",
  success: "saAnn.lvl.success",
};

/** A banner level in the reader's language; one the SPA doesn't
 *  list shows as sent. */
function levelLabel(level: string): string {
  return Object.hasOwn(LEVEL_LABELS, level) ? translate(LEVEL_LABELS[level]) : level;
}

export default function SuperadminAnnouncements() {
  const t = useT();
  const identity = getCurrentIdentity();
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useAnnouncements();

  if (identity?.role !== "superadmin") {
    return (
      <PageShell>
        <PageHeader title={navWord("Announcements")} />
        <Empty>{t("sa.scopeRequired")}</Empty>
      </PageShell>
    );
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["announcements", "list"] });
  }

  return (
    <PageShell>

      <PageCrumbs />

      <PageHeader
        title={navWord("Announcements")}
        subtitle={data ? t("saAnn.onFile", { count: fmtNumber(data.total) }) : "—"}
      />

      <CreateForm onCreated={refresh} />

      <div className={styles.gap} />

      <Card>
        <SectionTitle>{t("saAnn.history")}</SectionTitle>
        <p className={styles.helpText}>
          {t("saAnn.help")}
        </p>
        <DataTable
          columns={announcementColumns(refresh)}
          rows={data?.rows}
          rowKey={(r) => r.id}
          isLoading={isLoading} isError={isError} error={error}
          onRetry={() => { void refetch(); }}
          emptyTitle={t("saAnn.empty")}
        />
      </Card>
    </PageShell>
  );
}

function CreateForm({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [level, setLevel] =
    useState<CreateAnnouncementBody["level"]>("info");
  const [expiresDays, setExpiresDays] = useState("0");
  const [broadcast, setBroadcast] = useState(false);
  // Local form field for the optional schedule. Empty = "start
  // now". Stored as `<input type="datetime-local">` returns a
  // local string ("2026-05-15T14:00") so we convert to ISO+UTC
  // at submit.
  const [scheduleLocal, setScheduleLocal] = useState("");
  // Targeting: "all" = global (no target rows), "specific" = the
  // selected store ids. Kept as a Set for O(1) toggle.
  const [targetMode, setTargetMode] = useState<"all" | "specific">("all");
  const [targetIds, setTargetIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { dirty, markSaved } = useDirtyBaseline({
    message, level, expiresDays, broadcast, scheduleLocal, targetMode,
    targetIds: Array.from(targetIds),
  });
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("saAnn.unsaved"),
  });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    // A "specific" targeting with no store picked is almost certainly
    // a mistake — block it rather than silently posting a global
    // banner or one nobody can see.
    const target_store_ids =
      targetMode === "specific" ? Array.from(targetIds) : [];
    if (targetMode === "specific" && target_store_ids.length === 0) {
      setErr(t("saAnn.pickStore"));
      return;
    }
    setBusy(true);
    try {
      await createAnnouncement({
        message: message.trim(),
        level,
        expires_days: Number(expiresDays) || 0,
        broadcast,
        // "2026-05-15T14:00" is read on the same clock every
        // other time on screen uses; sent as a UTC instant.
        start_at_iso: zonedInputToUtcIso(scheduleLocal),
        target_store_ids,
      });
      setMessage(""); setExpiresDays("0"); setBroadcast(false);
      setScheduleLocal("");
      setTargetMode("all"); setTargetIds(new Set());
      // The level is kept for the next banner; what is left is clean.
      markSaved();
      onCreated();
    } catch (e) {
      setErr(apiErrorMessage(e, t("saAnn.postFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>{t("saAnn.newBanner")}</SectionTitle>
      <form onSubmit={onSubmit} className={styles.form}>
        <Field label={t("saAnn.message")}>
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("saAnn.messagePlaceholder")}
            rows={2}
            required
            style={{ minHeight: "3.5rem" }}
          />
        </Field>
        <div className={styles.fieldGrid}>
          <Field label={t("saAnn.level")}>
            <Select
              value={level}
              onChange={(e) =>
                setLevel(e.target.value as CreateAnnouncementBody["level"])
              }
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>{levelLabel(l)}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("saAnn.expires")}>
            <Input
              type="number"
              min="0"
              max="365"
              value={expiresDays}
              onChange={(e) => setExpiresDays(e.target.value)}
              placeholder={t("saAnn.noExpiry")}
            />
          </Field>
          <Field label={t("saAnn.schedule")}>
            <Input
              type="datetime-local"
              value={scheduleLocal}
              onChange={(e) => setScheduleLocal(e.target.value)}
            />
          </Field>
          <Field label={t("saAnn.emailBlast")}>
            <Checkbox checked={broadcast} onChange={setBroadcast}>
              {t("saAnn.alsoEmail")}
            </Checkbox>
          </Field>
        </div>
        <Field label={t("saAnn.audience")}>
          <div className={styles.targetModes}>
            <label className={styles.targetMode}>
              <input
                type="radio" name="targetMode" checked={targetMode === "all"}
                onChange={() => setTargetMode("all")}
              />
              <span>{t("saAnn.allStores")}</span>
            </label>
            <label className={styles.targetMode}>
              <input
                type="radio" name="targetMode" checked={targetMode === "specific"}
                onChange={() => setTargetMode("specific")}
              />
              <span>{t("saAnn.specific")}</span>
            </label>
          </div>
          {targetMode === "specific" && (
            <StorePicker selected={targetIds} onChange={setTargetIds} />
          )}
        </Field>
        {err && <Alert tone="error">{err}</Alert>}
        <FormActions guard={guard}>
          <Button
            type="submit"
            tone="primary"
            busy={busy}
            disabled={busy || !message.trim()}
          >
            {busy ? t("saAnn.posting") : t("saAnn.post")}
          </Button>
        </FormActions>
      </form>
    </Card>
  );
}

function StorePicker({
  selected, onChange,
}: {
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
}) {
  const t = useT();
  const { data, isLoading, isError, refetch } = useSuperadminStores();
  const [filter, setFilter] = useState("");

  const stores = data?.rows ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? stores.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          s.slug.toLowerCase().includes(needle),
      )
    : stores;

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <ErrorState
        message={t("saAnn.storesFailed")}
        onRetry={() => { void refetch(); }}
      />
    );
  }

  return (
    <div className={styles.storePicker}>
      <Input
        type="search"
        placeholder={t("saAnn.filterStores")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className={styles.storeList}>
        {shown.length === 0 ? (
          <span className={styles.helpText}>{t("saAnn.noMatch")}</span>
        ) : (
          shown.map((s) => (
            <Checkbox
              key={s.store_id}
              checked={selected.has(s.store_id)}
              onChange={() => toggle(s.store_id)}
              style={{ alignItems: "center", width: "100%" }}
            >
              {s.name}{" "}
              <Pill tone="neutral">{planLabel(s.plan)}</Pill>
            </Checkbox>
          ))
        )}
      </div>
      <div className={styles.pickerMeta}>
        <span>{tn("saStores.selected", selected.size, fmtNumber)}</span>
        {selected.size > 0 && (
          <button
            type="button" className={styles.linkBtn}
            onClick={() => onChange(new Set())}
          >
            {t("saStores.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The history list as the kit ``<DataTable>``. */
function announcementColumns(onChanged: () => void): DataColumn<AnnouncementRow>[] {
  const t = translate;
  return [
    {
      key: "message", header: t("saAnn.message"),
      render: (r) => <span className={styles.cellWide}>{r.message}</span>,
    },
    {
      key: "level", header: t("saAnn.level"),
      render: (r) => (
        <Pill tone={ANNOUNCEMENT_LEVEL_TONES[r.level] ?? "neutral"}>{levelLabel(r.level)}</Pill>
      ),
    },
    { key: "status", header: t("common.status"), render: (r) => <StatusCell row={r} /> },
    { key: "audience", header: t("saAnn.audience"), render: (r) => <AudienceCell row={r} /> },
    {
      key: "posted", header: t("saAnn.colPosted"),
      render: (r) => <span className={styles.dateCell}>{formatDate(r.created_at)}</span>,
    },
    {
      key: "expires", header: t("saAnn.colExpires"),
      render: (r) => (r.expires_at
        ? <span className={styles.dateCell}>{formatDate(r.expires_at)}</span>
        : <span className={styles.dash}>—</span>),
    },
    { key: "broadcast", header: t("saAnn.colBroadcast"), render: (r) => <BroadcastCell row={r} /> },
    {
      key: "actions", header: t("common.actions"), label: "",
      render: (r) => <ActionsCell row={r} onChanged={onChanged} />,
    },
  ];
}

function StatusCell({ row }: { row: AnnouncementRow }) {
  const t = useT();
  if (row.is_visible) return <Pill tone="accent">{t("saAnn.live")}</Pill>;
  if (!row.is_active) return <Pill tone="neutral">{t("saAnn.disabled")}</Pill>;
  if (isScheduledForFuture(row.starts_at)) {
    return (
      <Pill tone="info">
        {t("saAnn.scheduled", { when: formatScheduleHint(row.starts_at) })}
      </Pill>
    );
  }
  return <Pill tone="warning">{t("saAnn.expired")}</Pill>;
}

function ActionsCell({ row, onChanged }: { row: AnnouncementRow; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A refused delete keeps its dialog open, so its error shows there.
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function onToggle() {
    setErr(null); setBusy(true);
    try {
      await toggleAnnouncement(row.id, !row.is_active);
      onChanged();
    } catch (e) {
      setErr(apiErrorMessage(e, t("saAnn.toggleFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setDeleteErr(null); setBusy(true);
    try {
      await deleteAnnouncement(row.id);
      onChanged();
      setConfirmingDelete(false);
    } catch (e) {
      setDeleteErr(apiErrorMessage(e, t("saAnn.deleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={styles.actionsRow}>
        <Button tone="secondary" size="sm" busy={busy} onClick={onToggle}>
          {row.is_active ? t("saFlags.disable") : t("saFlags.enable")}
        </Button>
        <Button tone="danger" size="sm" busy={busy}
          onClick={() => setConfirmingDelete(true)}>
          {t("common.delete")}
        </Button>
      </div>
      {err && <span className={styles.rowError}>{err}</span>}
      <ConfirmDialog
        open={confirmingDelete}
        title={t("saAnn.deleteTitle")}
        message={t("saAnn.deleteBody")}
        confirmLabel={t("common.delete")}
        confirmTone="danger"
        busy={busy}
        error={deleteErr}
        onConfirm={() => { void doDelete(); }}
        onCancel={() => { setConfirmingDelete(false); setDeleteErr(null); }}
      />
    </>
  );
}

// True when `starts_at` is a parseable future date — drives the
// "scheduled" status pill on each table row.
function isScheduledForFuture(iso: string): boolean {
  const d = parseTimestamp(iso);
  return d != null && d.getTime() > Date.now();
}

// Short, human-readable hint for when the schedule will fire,
// rendered inside the scheduled status pill.
function formatScheduleHint(iso: string): string {
  if (!iso) return "";
  const d = parseTimestamp(iso);
  if (!d) return iso;
  const diffMs = d.getTime() - Date.now();
  const diffH = Math.round(diffMs / 3_600_000);
  if (diffH < 24) return translate("saAnn.inHours", { count: fmtNumber(diffH) });
  return formatDateTime(iso);
}


// Audience cell: "All stores" for a global announcement (no
// targeting rows) or an "N stores" pill listing the target store
// names underneath. Targeting was added in PR B — pre-targeting
// rows come back with an empty list and render as global.
function AudienceCell({ row }: { row: AnnouncementRow }) {
  const t = useT();
  const names = row.target_store_names ?? [];
  if (names.length === 0) {
    return <Pill tone="neutral">{t("saAnn.allStores")}</Pill>;
  }
  return (
    <div>
      <Pill tone="info">
        {tn("saStores.stores", names.length, fmtNumber)}
      </Pill>
      <div className={styles.audienceNames}>
        {names.slice(0, 3).join(", ")}
        {names.length > 3 ? ` ${t("saAnn.more", { count: fmtNumber(names.length - 3) })}` : ""}
      </div>
    </div>
  );
}

// Broadcast-state pill: shows whether "Also email all users" was
// ticked at create time and whether the fan-out has fired yet.
//
//   not requested  → "—"            (creator didn't ask for email)
//   requested + not sent → "pending"  (queued or scheduled banner not yet activated)
//   sent           → "sent · MMM dd"  (with date the broadcast landed)
function BroadcastCell({ row }: { row: AnnouncementRow }) {
  const t = useT();
  if (!row.broadcast_requested) {
    return <span className={styles.dash}>—</span>;
  }
  if (!row.broadcast_sent_at) {
    return <Pill tone="warning">{t("saAnn.pending")}</Pill>;
  }
  const stamp = formatShortDate(row.broadcast_sent_at);
  return <Pill tone="accent">{t("saAnn.sent", { date: stamp })}</Pill>;
}

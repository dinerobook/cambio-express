import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  CTR_STATUS_TONES, ctrFieldLabel, ctrStatusLabel, fetchCtrsPage, fileCtr,
  idTypeLabel, useCtr, useCtrs, type CtrListQuery, type CtrRow,
} from "../api/checkCashing";
import { TinValue } from "../components/CtrDetails";
import { DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Alert, Button, Card, DataTable, DateInput, Empty, ErrorState, Field, Input,
  KpiCard, KpiGrid, Loading, Modal, PageHeader, Pill, SectionTitle, Table,
  TabsBar, TabsButton, useToast, type DataColumn,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { tn, useT, type MessageKey, type Translate } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { csvMoney } from "../lib/csv";
import { csvDate, formatDate, formatDateTime, todayIso } from "../lib/datetime";
import { fmtMoney2, fmtNumber } from "../lib/formatters";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import styles from "./CheckCashing.module.css";

// Check cashing app → Compliance (/app/check-cashing/compliance).
// Currency Transaction Reports: a customer's cash over $10,000 in one
// business day (from $1,000 under the Southwest Border order), soonest
// deadline first. A row opens the report with every field FinCEN's
// BSA E-Filing form asks for; once filed there, the manager saves the
// BSA ID FinCEN gives back and the report locks. Managers only.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("CTR").

/** The tabs: "" (the default) is To file. */
const VIEWS: Array<{ slug: string; status: string; label: MessageKey }> = [
  { slug: "",      status: "to_file", label: "checkCashing.ctrToFile" },
  { slug: "filed", status: "filed",   label: "checkCashing.ctrFiled" },
  { slug: "all",   status: "",        label: "checkCashing.all" },
];

function DueCell({ row }: { row: CtrRow }) {
  const t = useT();
  return (
    <span className={styles.statusCell}>
      <span className={styles.day}>{formatDate(row.due_on)}</span>
      {row.overdue && <Pill tone="negative">{t("checkCashing.ctrOverdue")}</Pill>}
    </span>
  );
}

function columns(t: Translate): DataColumn<CtrRow>[] {
  return [
    {
      key: "day", header: t("checkCashing.colDay"),
      render: (r) => <span className={styles.day}>{formatDate(r.store_day)}</span>,
      csv: (r) => csvDate(r.store_day),
    },
    {
      key: "customer", header: t("checkCashing.colCustomer"),
      render: (r) => <span className={styles.name}>{r.customer_name}</span>,
      csv: (r) => r.customer_name,
    },
    {
      key: "cash", header: t("checkCashing.colCash"), align: "right",
      render: (r) => <span className={styles.mono}>{fmtMoney2(r.cash)}</span>,
      csv: (r) => csvMoney(r.cash),
    },
    {
      key: "kind", header: t("checkCashing.ctrKind"),
      render: (r) => t(r.kind === "gto" ? "checkCashing.ctrKindGto" : "checkCashing.ctrKindCtr"),
      csv: (r) => t(r.kind === "gto" ? "checkCashing.ctrKindGto" : "checkCashing.ctrKindCtr"),
    },
    {
      key: "due", header: t("checkCashing.ctrDueOn"),
      render: (r) => <DueCell row={r} />,
      csv: (r) => csvDate(r.due_on),
    },
    {
      key: "status", header: t("checkCashing.status"),
      render: (r) => (
        <Pill tone={CTR_STATUS_TONES[r.status] ?? "neutral"}>{ctrStatusLabel(r.status)}</Pill>
      ),
      csv: (r) => ctrStatusLabel(r.status),
    },
    {
      key: "bsa", header: t("checkCashing.bsaId"),
      render: (r) => <span className={styles.mono}>{r.bsa_id || "—"}</span>,
      csv: (r) => r.bsa_id,
    },
    {
      key: "store", header: t("checkCashing.colStore"),
      render: (r) => <span className={styles.muted}>{r.store_name || "—"}</span>,
      csv: (r) => r.store_name,
    },
  ];
}

export default function CheckCompliance() {
  const t = useT();
  const identity = getCurrentIdentity();
  const filters = useUrlFilterState({ q: "", view: "" }, { pageSizeKey: "check-ctrs" });
  const view = VIEWS.find((v) => v.slug === filters.params.view) ?? VIEWS[0];
  const listQuery: CtrListQuery = { q: filters.params.q, status: view.status };
  const { data, isLoading, isError, error, refetch } = useCtrs({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const [open, setOpen] = useState<number | null>(null);
  const title = navWord("Compliance");

  if (identity?.store_id == null) {
    return (
      <DeskPage>
        <PageCrumbs />
        <PageHeader title={title} />
        <Empty>{t("checkCashing.signIn")}</Empty>
      </DeskPage>
    );
  }

  return (
    <DeskPage>
      <PageCrumbs />
      <PageHeader
        title={title}
        subtitle={data ? tn("checkCashing.ctrCount", data.total, fmtNumber) : "—"}
      />

      <KpiGrid minWidth="10rem">
        <KpiCard
          label={t("checkCashing.ctrToFile")}
          value={data ? fmtNumber(data.counts.to_file) : "—"}
          tone={data && data.counts.to_file > 0 ? "warning" : "neutral"}
        />
        <KpiCard
          label={t("checkCashing.ctrDueSoon")}
          value={data ? fmtNumber(data.counts.due_soon) : "—"}
        />
        <KpiCard
          label={t("checkCashing.ctrOverdue")}
          value={data ? fmtNumber(data.counts.overdue) : "—"}
          tone={data && data.counts.overdue > 0 ? "negative" : "neutral"}
        />
      </KpiGrid>

      <Card className={styles.search}>
        <Field label={t("checkCashing.search")} hint={t("checkCashing.ctrHowTo")}>
          <Input
            type="search"
            value={filters.draft.q ?? filters.params.q}
            onChange={(e) => filters.debounced("q", e.target.value)}
            placeholder={t("checkCashing.ctrSearchPlaceholder")}
          />
        </Field>
      </Card>

      <TabsBar>
        {VIEWS.map((v) => (
          <TabsButton
            key={v.slug}
            active={view.slug === v.slug}
            onClick={() => filters.setParam("view", v.slug)}
          >
            {t(v.label)}
          </TabsButton>
        ))}
      </TabsBar>

      <DeskPane>
        <Card>
          <DataTable
            columns={columns(t)}
            rows={data?.rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r.id)}
            rowLabel={(r) => t("checkCashing.ctrOpen", { name: r.customer_name })}
            isLoading={isLoading} isError={isError} error={error}
            onRetry={() => { void refetch(); }}
            emptyTitle={t("checkCashing.ctrNone")}
            emptyBody={t("checkCashing.ctrNoneHint")}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: "ctrs",
              fetchPage: (page, perPage) => fetchCtrsPage({ ...listQuery, page, perPage }),
            }}
          />
        </Card>
      </DeskPane>

      <CtrModal id={open} onClose={() => setOpen(null)} />
    </DeskPage>
  );
}

/** One CTR: the filer, the person, the checks, and Mark filed. */
function CtrModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useCtr(id);
  const [bsaId, setBsaId] = useState("");
  const [filedOn, setFiledOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctr = detail.data?.ctr;

  function close() {
    setBsaId(""); setFiledOn(todayIso()); setError(null);
    onClose();
  }

  async function markFiled() {
    if (!ctr) return;
    setBusy(true); setError(null);
    try {
      await fileCtr(ctr.row.id, { bsa_id: bsaId, filed_on: filedOn });
      await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      toast({ message: t("checkCashing.ctrFiledSaved"), tone: "success" });
      setBsaId("");
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.ctrFileFailed")));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (detail.isError && !ctr) {
    body = (
      <ErrorState
        message={apiErrorMessage(detail.error, t("checkCashing.loadFailed"))}
        onRetry={() => void detail.refetch()}
        busy={detail.isFetching}
      />
    );
  } else if (!ctr) {
    body = <Loading />;
  } else {
    const { row, filer, person } = ctr;
    body = (
      <div className={styles.reviewStack}>
        <p className={styles.statusCell}>
          <Pill tone={CTR_STATUS_TONES[row.status] ?? "neutral"}>{ctrStatusLabel(row.status)}</Pill>
          <span className={styles.note}>
            {t("checkCashing.ctrSummary", {
              cash: fmtMoney2(row.cash), day: formatDate(row.store_day),
              due: formatDate(row.due_on),
            })}
          </span>
        </p>
        {ctr.gto_mark && (
          <Alert tone="info">{t("checkCashing.ctrGtoNote", { mark: ctr.gto_mark })}</Alert>
        )}

        <SectionTitle>{t("checkCashing.ctrFiler")}</SectionTitle>
        {filer.missing.length > 0 && (
          <Alert tone="warning">
            {t("checkCashing.ctrFilerMissing", {
              fields: filer.missing.map(ctrFieldLabel).join(", "),
            })}
          </Alert>
        )}
        <dl className={styles.factList}>
          <dt>{t("checkCashing.legalName")}</dt><dd>{filer.legal_name || "—"}</dd>
          <dt>{t("checkCashing.dbaName")}</dt><dd>{filer.dba_name || "—"}</dd>
          <dt>{t("checkCashing.ein")}</dt><dd className={styles.mono}>{filer.ein || "—"}</dd>
          <dt>{t("checkCashing.address")}</dt>
          <dd>{[filer.street, filer.city, filer.state, filer.zip_code].filter(Boolean).join(", ") || "—"}</dd>
          <dt>{t("checkCashing.contactName")}</dt>
          <dd>{[filer.contact_name, filer.contact_phone].filter(Boolean).join(" · ") || "—"}</dd>
          {filer.msb_registration && (
            <>
              <dt>{t("checkCashing.msbRegistration")}</dt>
              <dd className={styles.mono}>{filer.msb_registration}</dd>
            </>
          )}
        </dl>

        <SectionTitle>{t("checkCashing.ctrPerson")}</SectionTitle>
        {person.missing.length > 0 && (
          <Alert tone="warning">
            {t("checkCashing.ctrMissing", {
              fields: person.missing.map(ctrFieldLabel).join(", "),
            })}
          </Alert>
        )}
        <dl className={styles.factList}>
          <dt>{t("checkCashing.fullName")}</dt><dd>{person.full_name}</dd>
          <dt>{t("checkCashing.tin")}</dt>
          <dd><TinValue customerId={row.customer_id} masked={person.tin_masked} type={person.tin_type} /></dd>
          <dt>{t("checkCashing.dob")}</dt><dd>{person.dob ? formatDate(person.dob) : "—"}</dd>
          <dt>{t("checkCashing.occupation")}</dt><dd>{person.occupation || "—"}</dd>
          <dt>{t("checkCashing.address")}</dt>
          <dd>
            {[person.address, person.city, person.state, person.zip_code, person.country]
              .filter(Boolean).join(", ") || "—"}
          </dd>
          <dt>{t("checkCashing.idTitle")}</dt>
          <dd>
            {person.id_number
              ? [idTypeLabel(person.id_type), person.id_number, person.id_issuer].filter(Boolean).join(" · ")
              : "—"}
          </dd>
          {person.phone && (<><dt>{t("checkCashing.phone")}</dt><dd className={styles.mono}>{person.phone}</dd></>)}
        </dl>

        <SectionTitle>{tn("checkCashing.checkCount", ctr.checks.length, fmtNumber)}</SectionTitle>
        <Table>
          <thead>
            <tr>
              <th>{t("checkCashing.colCompany")}</th>
              <th style={{ textAlign: "right" }}>{t("checkCashing.colCheck")}</th>
              <th style={{ textAlign: "right" }}>{t("checkCashing.colFee")}</th>
              <th style={{ textAlign: "right" }}>{t("checkCashing.colCash")}</th>
            </tr>
          </thead>
          <tbody>
            {ctr.checks.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.company_name}
                  {c.check_number && <span className={styles.muted}> · #{c.check_number}</span>}
                  <div className={styles.muted}>
                    {[formatDateTime(c.created_at), c.store_name].filter(Boolean).join(" · ")}
                  </div>
                </td>
                <td className={styles.mono} style={{ textAlign: "right" }}>{fmtMoney2(c.amount)}</td>
                <td className={styles.mono} style={{ textAlign: "right" }}>{fmtMoney2(c.fee)}</td>
                <td className={styles.mono} style={{ textAlign: "right" }}>{fmtMoney2(c.cash)}</td>
              </tr>
            ))}
          </tbody>
        </Table>

        {row.status === "filed" ? (
          <Alert tone="success">
            {t("checkCashing.ctrFiledLine", {
              bsa: row.bsa_id, day: row.filed_on ? formatDate(row.filed_on) : "",
              by: ctr.filed_by || "—",
            })}
          </Alert>
        ) : row.status === "to_file" ? (
          <>
            <SectionTitle>{t("checkCashing.ctrMarkFiled")}</SectionTitle>
            <p className={styles.note}>{t("checkCashing.ctrMarkFiledHint")}</p>
            <div className={styles.fieldGrid}>
              <Field label={t("checkCashing.bsaId")}>
                <Input
                  type="text" inputMode="numeric" className={styles.mono}
                  value={bsaId} onChange={(e) => setBsaId(e.target.value.replace(/\D/g, "").slice(0, 14))}
                />
              </Field>
              <Field label={t("checkCashing.ctrFiledOn")}>
                <DateInput value={filedOn} required onChange={(e) => setFiledOn(e.target.value)} />
              </Field>
            </div>
            {error && <Alert tone="error">{error}</Alert>}
            <div>
              <Button
                type="button" busy={busy}
                disabled={busy || bsaId.length !== 14 || !filedOn}
                onClick={() => { void markFiled(); }}
              >
                {t("checkCashing.ctrMarkFiled")}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <Modal
      open={id != null} onClose={close} size="lg" disabled={busy}
      title={ctr ? t("checkCashing.ctrTitle", { name: ctr.person.full_name }) : t("checkCashing.ctrTitleShort")}
      actions={(
        <Button type="button" tone="secondary" onClick={close}>{t("common.close")}</Button>
      )}
    >
      {body}
    </Modal>
  );
}

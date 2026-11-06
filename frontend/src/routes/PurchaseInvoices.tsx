import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  deleteInvoice, fetchInvoicesPage, updateInvoice, useInvoices, useVendors,
  type InvoiceRow,
} from "../api/catalog";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import { hasPermission } from "../lib/permissions";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import {
  ButtonLink, Card, ConfirmDialog, DataTable, Field,
  InfoTip, Input, PageHeader, PageShell, Pill,
  RowActions, Section, Select, useToast, type DataColumn,
} from "../components/ui";
import styles from "./PurchaseInvoices.module.css";
import { csvDate, formatDate, todayIso } from "../lib/datetime";
import { csvMoney } from "../lib/csv";
import { PageCrumbs } from "../components/PageCrumbs";
import { useT } from "../i18n";

// /app/purchase-invoices — vendor invoice log (P3-2). Key each
// paper invoice, optionally line-by-line with price-book links so
// costs flow back into the catalog. List here; entry/edit on the
// dedicated form page (lines don't fit a modal).

export default function PurchaseInvoices() {
  const t = useT();
  const canManage = hasPermission("catalog", "update");
  // 300ms debounce + 2-char minimum via the shared URL-filter hook
  // (CLAUDE.md "Table search UX").
  const filters = useUrlFilterState({ q: "", vendor_id: "", status: "" }, {
    pageSizeKey: "purchase-invoices",
    defaultSort: { key: "date", direction: "desc" },
  });
  const listQuery = {
    q: filters.params.q,
    vendorId: filters.params.vendor_id,
    status: filters.params.status,
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
  };
  const invoices = useInvoices({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const vendors = useVendors();
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const navigate = useNavigate();
  // Deleting drops the invoice and its lines, so it goes through a
  // confirm (UI-STANDARDS §2) rather than straight from the row.
  const [pendingRemove, setPendingRemove] = useState<InvoiceRow | null>(null);
  const [removing, setRemoving] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["catalog", "invoices"] });
  }

  async function togglePaid(inv: InvoiceRow) {
    try {
      await updateInvoice(
        inv.id,
        inv.status === "paid"
          ? { status: "open" }
          : { status: "paid", paid_on: todayIso() },
      );
      refresh();
    } catch (err) {
      toastApiError(err, t("inv.updateFailed"));
    }
  }

  async function remove() {
    const inv = pendingRemove;
    if (!inv) return;
    setRemoving(true);
    try {
      await deleteInvoice(inv.id);
      setPendingRemove(null);
      refresh();
      toast({
        message: t("inv.deleted", { number: inv.invoice_number }),
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, t("inv.deleteFailed"));
    } finally {
      setRemoving(false);
    }
  }

  const data = invoices.data;
  const columns: DataColumn<InvoiceRow>[] = [
    {
      key: "number", header: t("inv.colNumber"), sortKey: "number",
      render: (inv) => <span className={styles.mono}>{inv.invoice_number}</span>,
      csv: (inv) => inv.invoice_number,
    },
    { key: "vendor", header: t("inv.colVendor"), render: (inv) => inv.vendor_name, csv: (inv) => inv.vendor_name },
    {
      key: "date", header: t("inv.colDate"), sortKey: "date", sortFirst: "desc",
      render: (inv) => formatDate(inv.invoice_date),
      csv: (inv) => csvDate(inv.invoice_date),
    },
    {
      key: "due", header: t("inv.colDue"), sortKey: "due", sortFirst: "desc",
      render: (inv) => (inv.due_date ? formatDate(inv.due_date) : "—"),
      csv: (inv) => csvDate(inv.due_date),
    },
    {
      key: "total", header: t("inv.colTotal"), align: "right", sortKey: "total", sortFirst: "desc",
      render: (inv) => <span className={styles.mono}>{fmtMoney2(inv.total)}</span>,
      csv: (inv) => csvMoney(inv.total),
    },
    { key: "lines", header: t("inv.colLines"), align: "right", render: (inv) => inv.line_count,
      csv: (inv) => inv.line_count },
    {
      key: "status", header: t("common.status"), sortKey: "status",
      render: (inv) => (
        <Pill tone={inv.status === "paid" ? "success" : "warning"}>
          {inv.status === "paid"
            ? (inv.paid_on ? t("inv.paidOn", { date: formatDate(inv.paid_on) }) : t("inv.paidPill"))
            : t("inv.openPill")}
        </Pill>
      ),
      csv: (inv) => (inv.status === "paid" ? t("inv.paid") : t("inv.open")),
    },
    ...(canManage ? [{
      key: "actions", header: "", label: "", align: "right" as const,
      render: (inv: InvoiceRow) => (
        <RowActions
          title={inv.invoice_number}
          actions={[
            {
              label: t("common.edit"),
              tone: "primary",
              onClick: () => navigate(`/purchase-invoices/${inv.id}`),
            },
            {
              label: inv.status === "paid" ? t("inv.reopen") : t("inv.markPaid"),
              tone: "primary",
              onClick: () => togglePaid(inv),
            },
            {
              label: t("inv.delete"),
              tone: "warning",
              onClick: () => setPendingRemove(inv),
            },
          ]}
        />
      ),
    }] : []),
  ];
  return (
    <PageShell maxWidth="72rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {t("inv.title")}
            <InfoTip text={t("inv.tip")} />
          </>
        }
        subtitle={t("inv.subtitle")}
        actions={
          canManage ? (
            <ButtonLink to="/purchase-invoices/new" size="sm">
              {t("inv.add")}
            </ButtonLink>
          ) : undefined
        }
      />
      <Section title={t("inv.invoices")}>
        <div className={styles.filtersRow}>
          <div className={styles.searchField}>
            <Field label={t("posTx.search")}>
              <Input
                type="search"
                placeholder={t("inv.searchPlaceholder")}
                value={filters.draft.q ?? filters.params.q}
                onChange={(e) => filters.debounced("q", e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("inv.colVendor")}>
            <Select
              value={filters.params.vendor_id}
              onChange={(e) => filters.setParam("vendor_id", e.target.value)}
            >
              <option value="">{t("inv.all")}</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </Select>
          </Field>
          <Field label={t("common.status")}>
            <Select
              value={filters.params.status}
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              <option value="">{t("inv.all")}</option>
              <option value="open">{t("inv.open")}</option>
              <option value="paid">{t("inv.paid")}</option>
            </Select>
          </Field>
        </div>
        <Card>
          <DataTable
            columns={columns}
            rows={data?.rows}
            rowKey={(inv) => inv.id}
            onRowClick={canManage ? (inv) => navigate(`/purchase-invoices/${inv.id}`) : undefined}
            rowLabel={(inv) => t("inv.openRow", { number: inv.invoice_number })}
            isLoading={invoices.isLoading}
            isError={invoices.isError}
            error={invoices.error}
            errorMessage={t("inv.loadFailed")}
            onRetry={() => { void invoices.refetch(); }}
            emptyTitle={
              filters.params.q || filters.params.vendor_id
              || filters.params.status
                ? t("inv.noMatch")
                : t("inv.none")
            }
            emptyBody={
              canManage
                ? t("inv.emptyManage")
                : t("inv.emptyView")
            }
            sort={filters.sort}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
            exportCsv={{
              filename: "purchase-invoices",
              fetchPage: (page, perPage) => fetchInvoicesPage({ ...listQuery, page, perPage }),
              extraColumns: [
                { header: t("inv.paidOnCsv"), csv: (inv) => csvDate(inv.paid_on) },
              ],
            }}
          />
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingRemove != null}
        title={t("inv.deleteTitle")}
        message={t("inv.deleteMessage", { number: pendingRemove?.invoice_number ?? "" })}
        confirmLabel={t("inv.delete")}
        confirmTone="danger"
        busy={removing}
        onConfirm={() => { void remove(); }}
        onCancel={() => setPendingRemove(null)}
      />
    </PageShell>
  );
}

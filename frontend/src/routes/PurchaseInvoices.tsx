import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  deleteInvoice, updateInvoice, useInvoices, useVendors,
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
import { formatDate, todayIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";

// /app/purchase-invoices — vendor invoice log (P3-2). Key each
// paper invoice, optionally line-by-line with price-book links so
// costs flow back into the catalog. List here; entry/edit on the
// dedicated form page (lines don't fit a modal).

export default function PurchaseInvoices() {
  const canManage = hasPermission("catalog", "update");
  // 300ms debounce + 2-char minimum via the shared URL-filter hook
  // (CLAUDE.md "Table search UX").
  const filters = useUrlFilterState({ q: "", vendor_id: "", status: "" }, {
    pageSizeKey: "purchase-invoices",
    defaultSort: { key: "date", direction: "desc" },
  });
  const invoices = useInvoices({
    q: filters.params.q,
    page: filters.page,
    vendorId: filters.params.vendor_id,
    status: filters.params.status,
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
    perPage: filters.perPage,
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
      toastApiError(err, "Could not update the invoice.");
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
        message: `Invoice ${inv.invoice_number} deleted.`,
        tone: "success",
      });
    } catch (err) {
      toastApiError(err, "Could not delete the invoice.");
    } finally {
      setRemoving(false);
    }
  }

  const data = invoices.data;
  const columns: DataColumn<InvoiceRow>[] = [
    {
      key: "number", header: "Invoice #", sortKey: "number",
      render: (inv) => <span className={styles.mono}>{inv.invoice_number}</span>,
    },
    { key: "vendor", header: "Vendor", render: (inv) => inv.vendor_name },
    {
      key: "date", header: "Date", sortKey: "date", sortFirst: "desc",
      render: (inv) => formatDate(inv.invoice_date),
    },
    {
      key: "due", header: "Due", sortKey: "due", sortFirst: "desc",
      render: (inv) => (inv.due_date ? formatDate(inv.due_date) : "—"),
    },
    {
      key: "total", header: "Total", align: "right", sortKey: "total", sortFirst: "desc",
      render: (inv) => <span className={styles.mono}>{fmtMoney2(inv.total)}</span>,
    },
    { key: "lines", header: "Lines", align: "right", render: (inv) => inv.line_count },
    {
      key: "status", header: "Status", sortKey: "status",
      render: (inv) => (
        <Pill tone={inv.status === "paid" ? "success" : "warning"}>
          {inv.status === "paid"
            ? `paid ${inv.paid_on ? formatDate(inv.paid_on) : ""}`.trim()
            : "open"}
        </Pill>
      ),
    },
    ...(canManage ? [{
      key: "actions", header: "", label: "", align: "right" as const,
      render: (inv: InvoiceRow) => (
        <RowActions
          title={inv.invoice_number}
          actions={[
            {
              label: "Edit",
              tone: "primary",
              onClick: () => navigate(`/purchase-invoices/${inv.id}`),
            },
            {
              label: inv.status === "paid" ? "Reopen" : "Mark paid",
              tone: "primary",
              onClick: () => togglePaid(inv),
            },
            {
              label: "Delete",
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
            Purchase invoices
            <InfoTip text="Key each vendor invoice as it arrives. Link lines to price-book items and their unit costs can update your catalog automatically." />
          </>
        }
        subtitle="What the store bought, from whom, and for how much."
        actions={
          canManage ? (
            <ButtonLink to="/purchase-invoices/new" size="sm">
              + Add invoice
            </ButtonLink>
          ) : undefined
        }
      />
      <Section title="Invoices">
        <div className={styles.filtersRow}>
          <div className={styles.searchField}>
            <Field label="Search">
              <Input
                type="search"
                placeholder="Invoice number…"
                value={filters.draft.q ?? filters.params.q}
                onChange={(e) => filters.debounced("q", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Vendor">
            <Select
              value={filters.params.vendor_id}
              onChange={(e) => filters.setParam("vendor_id", e.target.value)}
            >
              <option value="">All</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select
              value={filters.params.status}
              onChange={(e) => filters.setParam("status", e.target.value)}
            >
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="paid">Paid</option>
            </Select>
          </Field>
        </div>
        <Card>
          <DataTable
            columns={columns}
            rows={data?.rows}
            rowKey={(inv) => inv.id}
            onRowClick={canManage ? (inv) => navigate(`/purchase-invoices/${inv.id}`) : undefined}
            rowLabel={(inv) => `Open invoice ${inv.invoice_number}`}
            isLoading={invoices.isLoading}
            isError={invoices.isError}
            error={invoices.error}
            errorMessage="Could not load invoices."
            onRetry={() => { void invoices.refetch(); }}
            emptyTitle={
              filters.params.q || filters.params.vendor_id
              || filters.params.status
                ? "No invoices match"
                : "No invoices yet"
            }
            emptyBody={
              canManage
                ? 'Key your first vendor invoice with "+ Add invoice".'
                : "No invoices on file."
            }
            sort={filters.sort}
            page={data && {
              page: data.page, totalPages: data.total_pages, total: data.total,
              onPage: filters.setPage,
              perPage: filters.perPage, onPerPage: filters.setPerPage,
            }}
          />
        </Card>
      </Section>

      <ConfirmDialog
        open={pendingRemove != null}
        title="Delete this invoice?"
        message={`Delete invoice ${pendingRemove?.invoice_number ?? ""} and its lines? This cannot be undone.`}
        confirmLabel="Delete"
        confirmTone="danger"
        busy={removing}
        onConfirm={() => { void remove(); }}
        onCancel={() => setPendingRemove(null)}
      />
    </PageShell>
  );
}

import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createItem, createVendor, updateItem, updateVendor,
  fetchItemsPage, useItems, useVendors,
  type PriceBookItem, type Vendor,
} from "../api/catalog";
import {
  commitPriceBookSeed, previewPriceBookSeed,
  type PriceBookHarvest,
} from "../api/posimport";
import { useDepartments, type Department } from "../api/dayclose";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import { csvMoney } from "../lib/csv";
import { hasPermission } from "../lib/permissions";
import { useUrlFilterState } from "../lib/useUrlFilterState";
import DepartmentsManager from "../components/DepartmentsManager";
import {
  Alert, Button, Card, Checkbox, EmptyState, ErrorState,
  DataTable, Field, InfoTip, Input, Loading, Modal, MoneyInput, PageHeader, PageShell,
  Pill, RowActions, Section, Select, TabsBar, TabsButton, Table,
  tdStyle, thStyle, useToast, type DataColumn,
  ModalActions,
} from "../components/ui";
import styles from "./PriceBook.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, tNodes, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

const SEED_COLUMNS: MessageKey[] = ["posTx.colScanCode", "posTx.colItem", "dept.colDepartment", "posTx.colPrice"];
const VENDOR_COLUMNS: MessageKey[] = [
  "inv.colVendor", "pb.colContact", "common.phone", "pb.colAccount", "pb.tabItems", "common.status",
];
// The code type's name: the same in every language.
const PLU_PILL = "PLU";

// /app/price-book — the item catalog + vendor directory (P2-2).
// Three tabs on one page: Items (paginated live search over the
// price book), Vendors (the supplier directory items link to), and
// Departments (how sales are grouped, on items and on a register
// close alike). Everything here is an operator-owned catalog
// (HANDOFF.md §2 product principle) — cashiers can look items up
// (catalog.read), managing rows needs catalog.update.

export default function PriceBook() {
  useT(); // re-render on a language switch
  const [tab, setTab] = useState<"items" | "vendors" | "departments">(
    "items",
  );
  return (
    <PageShell maxWidth="72rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {navWord("Price book")}
            <InfoTip text={t("pb.tip")} />
          </>
        }
        subtitle={t("pb.subtitle")}
      />
      <TabsBar>
        <TabsButton active={tab === "items"} onClick={() => setTab("items")}>
          {t("pb.tabItems")}
        </TabsButton>
        <TabsButton
          active={tab === "vendors"}
          onClick={() => setTab("vendors")}
        >
          {t("pb.tabVendors")}
        </TabsButton>
        <TabsButton
          active={tab === "departments"}
          onClick={() => setTab("departments")}
        >
          {t("dept.title")}
        </TabsButton>
      </TabsBar>
      {tab === "items" && <ItemsTab />}
      {tab === "vendors" && <VendorsTab />}
      {tab === "departments" && <DepartmentsManager />}
    </PageShell>
  );
}

// ── Items tab ────────────────────────────────────────────────

function ItemsTab() {
  useT(); // re-render on a language switch
  const canManage = hasPermission("catalog", "update");
  // 300ms debounce + 2-char minimum via the shared URL-filter hook
  // (CLAUDE.md "Table search UX") — same wiring as Transfers.
  const filters = useUrlFilterState({
    q: "", department_id: "", vendor_id: "", inactive: "",
  }, {
    pageSizeKey: "price-book",
    defaultSort: { key: "name", direction: "asc" },
  });
  const listQuery = {
    q: filters.params.q,
    departmentId: filters.params.department_id,
    vendorId: filters.params.vendor_id,
    includeInactive: filters.params.inactive === "1",
    sort: filters.sort?.key,
    dir: filters.sort?.direction,
  };
  const items = useItems({
    ...listQuery, page: filters.page, perPage: filters.perPage,
  });
  const departments = useDepartments();
  const vendors = useVendors();
  const qc = useQueryClient();
  const toastApiError = useApiErrorToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PriceBookItem | null>(null);
  const [seeding, setSeeding] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["catalog"] });
  }

  async function toggleActive(item: PriceBookItem) {
    try {
      await updateItem(item.id, { is_active: !item.is_active });
      refresh();
    } catch (err) {
      toastApiError(err, t("pb.itemFailed"));
    }
  }

  const data = items.data;
  const columns: DataColumn<PriceBookItem>[] = [
    {
      key: "code", header: t("posTx.colScanCode"), sortKey: "code",
      render: (i) => (
        <>
          <span className={styles.posCode}>{i.pos_code}</span>
          {i.pos_code_format === "plu" && (
            <>
              {" "}
              <Pill tone="neutral">{PLU_PILL}</Pill>
            </>
          )}
        </>
      ),
      csv: (i) => i.pos_code,
    },
    { key: "name", header: t("posTx.colItem"), sortKey: "name", render: (i) => i.name, csv: (i) => i.name },
    { key: "department", header: t("dept.colDepartment"), render: (i) => i.department_name || "—",
      csv: (i) => i.department_name },
    { key: "vendor", header: t("inv.colVendor"), render: (i) => i.vendor_name || "—", csv: (i) => i.vendor_name },
    {
      key: "price", header: t("posTx.colPrice"), align: "right", sortKey: "price", sortFirst: "desc",
      render: (i) => fmtMoney2(i.price),
      csv: (i) => csvMoney(i.price),
    },
    {
      key: "cost", header: t("pb.colCost"), align: "right", sortKey: "cost", sortFirst: "desc",
      render: (i) => (i.cost > 0 ? fmtMoney2(i.cost) : "—"),
      csv: (i) => (i.cost > 0 ? csvMoney(i.cost) : ""),
    },
    { key: "tax", header: t("posTx.colTax"), render: (i) => (i.is_taxable ? t("pb.taxable") : "—"),
      csv: (i) => (i.is_taxable ? t("pb.taxable") : "") },
    {
      key: "status", header: t("common.status"),
      render: (i) => (
        <Pill tone={i.is_active ? "accent" : "neutral"}>
          {i.is_active ? t("dept.active") : t("dept.inactive")}
        </Pill>
      ),
      csv: (i) => (i.is_active ? t("pb.activeCsv") : t("pb.inactiveCsv")),
    },
    ...(canManage ? [{
      key: "actions", header: "", label: "", align: "right" as const,
      render: (i: PriceBookItem) => (
        <RowActions
          title={i.name}
          actions={[
            { label: t("common.edit"), tone: "primary", onClick: () => setEditing(i) },
            {
              label: i.is_active ? t("dept.deactivate") : t("dept.reactivate"),
              tone: i.is_active ? "warning" : "primary",
              onClick: () => toggleActive(i),
            },
          ]}
        />
      ),
    }] : []),
  ];
  return (
    <Section
      title={t("pb.tabItems")}
      actions={
        canManage ? (
          <div className={styles.toolbarActions}>
            <Button
              size="sm" tone="secondary"
              onClick={() =>
                filters.setParam(
                  "inactive", filters.params.inactive === "1" ? "" : "1",
                )
              }
            >
              {filters.params.inactive === "1"
                ? t("dept.hideInactive") : t("dept.showInactive")}
            </Button>
            <Button
              size="sm" tone="secondary"
              onClick={() => setSeeding(true)}
            >
              {t("pb.seed")}
            </Button>
            <a
              href="/api/v2/posimport/naxml/pricebook-export"
              download
              style={{ textDecoration: "none" }}
              title={t("pb.exportTitle")}
            >
              <Button size="sm" tone="secondary" type="button">
                {t("pb.export")}
              </Button>
            </a>
            <Button size="sm" onClick={() => setAdding(true)}>
              {t("pb.addItem")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className={styles.filtersRow}>
        <div className={styles.searchField}>
          <Field label={t("posTx.search")}>
            <Input
              type="search"
              placeholder={t("pb.searchPlaceholder")}
              value={filters.draft.q ?? filters.params.q}
              onChange={(e) => filters.debounced("q", e.target.value)}
            />
          </Field>
        </div>
        <Field label={t("dept.colDepartment")}>
          <Select
            value={filters.params.department_id}
            onChange={(e) =>
              filters.setParam("department_id", e.target.value)
            }
          >
            <option value="">{t("pb.all")}</option>
            {(departments.data?.departments ?? []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("inv.colVendor")}>
          <Select
            value={filters.params.vendor_id}
            onChange={(e) => filters.setParam("vendor_id", e.target.value)}
          >
            <option value="">{t("pb.all")}</option>
            {(vendors.data?.vendors ?? []).map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </Select>
        </Field>
      </div>
      <Card>
        <DataTable
          columns={columns}
          rows={data?.rows}
          rowKey={(i) => i.id}
          onRowClick={canManage ? setEditing : undefined}
          rowLabel={(i) => t("pb.editRow", { name: i.name })}
          isLoading={items.isLoading}
          isError={items.isError}
          error={items.error}
          errorMessage={t("pb.loadFailed")}
          onRetry={() => { void items.refetch(); }}
          emptyTitle={
            filters.params.q || filters.params.department_id
            || filters.params.vendor_id
              ? t("pb.noMatch")
              : t("pb.none")
          }
          emptyBody={
            canManage
              ? t("pb.emptyManage")
              : t("pb.emptyView")
          }
          sort={filters.sort}
          page={data && {
            page: data.page, totalPages: data.total_pages, total: data.total,
            onPage: filters.setPage,
            perPage: filters.perPage, onPerPage: filters.setPerPage,
          }}
          exportCsv={{
            filename: "price-book",
            fetchPage: (page, perPage) => fetchItemsPage({ ...listQuery, page, perPage }),
          }}
        />
      </Card>
      <ItemModal
        open={adding || editing != null}
        existing={editing}
        departments={departments.data?.departments ?? []}
        vendors={vendors.data?.vendors ?? []}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); refresh(); }}
      />
      <SeedModal
        open={seeding}
        onClose={() => setSeeding(false)}
        onDone={() => { setSeeding(false); refresh(); }}
      />
    </Section>
  );
}

// ── Seed-from-register modal (P2-3 warm start) ───────────────

function SeedModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          {t("pb.seedTitle")}
          <InfoTip text={t("pb.seedTip")} />
        </>
      }
    >
      {open && <SeedPreview onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function SeedPreview({
  onClose, onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  // Fresh fetch per open: the preview re-parses staged journals
  // server-side, so never serve it from cache.
  const previewQuery = useQuery<PriceBookHarvest>({
    queryKey: ["posimport", "pricebook-preview"],
    queryFn: previewPriceBookSeed,
    gcTime: 0,
    staleTime: 0,
  });
  useT(); // re-render on a language switch
  const preview = previewQuery.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function onCommit() {
    setBusy(true);
    setError(null);
    try {
      const result = await commitPriceBookSeed();
      toast({
        message: result.skipped_existing
          ? tn("pb.seededSkipped", result.created, String, { skipped: result.skipped_existing })
          : tn("pb.seeded", result.created),
        tone: "success",
      });
      onDone();
    } catch (err) {
      setError(
        apiErrorMessage(err, t("pb.seedFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.modalForm}>
      {error && <Alert tone="error">{error}</Alert>}
      {previewQuery.isLoading && <Loading />}
      {previewQuery.isError && (
        <ErrorState
          message={t("pb.readFailed")}
          onRetry={() => { void previewQuery.refetch(); }}
        />
      )}
      {preview != null && preview.items.length === 0 && (
        <EmptyState
          title={t("pb.noData")}
          body={t("pb.noDataBody")}
        />
      )}
      {preview != null && preview.items.length > 0 && (
        <>
          <p>
            {tNodes("pb.found", {
              found: <strong>{preview.items.length}</strong>,
              new: <strong>{preview.new_count}</strong>,
              existing: preview.existing_count,
            })}
          </p>
          <div style={{ overflowX: "auto", maxHeight: "18rem" }}>
            <Table>
              <thead>
                <tr>
                  {SEED_COLUMNS.map(
                    (h) => <th key={h} style={thStyle}>{t(h)}</th>,
                  )}
                  <th style={thStyle} />
                </tr>
              </thead>
              <tbody>
                {preview.items.slice(0, 50).map((i) => (
                  <tr key={i.pos_code}>
                    <td style={tdStyle}>
                      <span className={styles.posCode}>{i.pos_code}</span>
                    </td>
                    <td style={tdStyle}>{i.description || "—"}</td>
                    <td style={tdStyle}>{i.department_name || "—"}</td>
                    <td style={tdStyle}>{fmtMoney2(i.price)}</td>
                    <td style={tdStyle}>
                      {i.already_in_price_book && (
                        <Pill tone="neutral">{t("pb.alreadyAdded")}</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {preview.items.length > 50 && (
            <p>{t("pb.more", { count: preview.items.length - 50 })}</p>
          )}
        </>
      )}
      <ModalActions>
        <Button tone="secondary" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button" busy={busy}
          disabled={busy || preview == null || preview.new_count === 0}
          onClick={() => { void onCommit(); }}
        >
          {preview != null && preview.new_count > 0
            ? tn("pb.addN", preview.new_count)
            : t("pb.nothing")}
        </Button>
      </ModalActions>
    </div>
  );
}

// ── Item modal (add / edit one price-book item) ──────────────

function ItemModal({
  open, existing, departments, vendors, onClose, onDone,
}: {
  open: boolean;
  existing: PriceBookItem | null;
  departments: Department[];
  vendors: Vendor[];
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? t("pb.editRow", { name: existing.name }) : t("pb.addItemTitle")}
    >
      {open && (
        // Keyed remount resets the form per open/target — prefill
        // via initializers, no state-sync effect needed.
        <ItemForm
          key={existing?.id ?? "new"}
          existing={existing}
          departments={departments}
          vendors={vendors}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

function ItemForm({
  existing, departments, vendors, onClose, onDone,
}: {
  existing: PriceBookItem | null;
  departments: Department[];
  vendors: Vendor[];
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [posCode, setPosCode] = useState(existing?.pos_code ?? "");
  const [posFormat, setPosFormat] = useState(
    existing?.pos_code_format ?? "upc",
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [departmentId, setDepartmentId] = useState(
    existing?.department_id != null ? String(existing.department_id) : "",
  );
  const [vendorId, setVendorId] = useState(
    existing?.vendor_id != null ? String(existing.vendor_id) : "",
  );
  // Money fields hold numbers: <MoneyInput> shows 0 as an empty box
  // and hands back 0 for one, so "" and 0 are the same value here.
  const [price, setPrice] = useState(existing?.price ?? 0);
  const [cost, setCost] = useState(existing?.cost ?? 0);
  const [taxable, setTaxable] = useState(existing?.is_taxable ?? true);
  // Item-editor parity (P2-5): vendor item #, size label, case
  // pack, EBT, margin helper.
  const [itemNumber, setItemNumber] = useState(existing?.item_number ?? "");
  const [size, setSize] = useState(existing?.size ?? "");
  const [caseSize, setCaseSize] = useState(
    existing?.case_size != null ? String(existing.case_size) : "",
  );
  const [caseCost, setCaseCost] = useState(existing?.case_cost ?? 0);
  const [ebt, setEbt] = useState(existing?.is_ebt ?? false);
  const [marginGoal, setMarginGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cronysoft-style Department → Sub Department cascade. The flat
  // department list carries parent_id; departmentId always holds
  // the LEAF that gets stored on the item (a sub-department when
  // one is picked, else the parent). Both selects derive from it.
  const parents = departments.filter((d) => d.parent_id == null);
  const currentDept = departments.find(
    (d) => String(d.id) === departmentId,
  );
  const parentSel =
    currentDept == null
      ? ""
      : String(currentDept.parent_id ?? currentDept.id);
  const subSel = currentDept?.parent_id != null ? departmentId : "";
  const subs = departments.filter(
    (d) => parentSel !== "" && d.parent_id === Number(parentSel),
  );

  // Derived numbers for the pricing helpers.
  const caseSizeNum = Number.parseInt(caseSize, 10) || 0;
  const unitFromCase =
    caseSizeNum > 0 && caseCost > 0 ? caseCost / caseSizeNum : null;
  const margin =
    price > 0 ? ((price - cost) / price) * 100 : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await updateItem(existing.id, {
          pos_code: posCode.trim(),
          pos_code_format: posFormat,
          name: name.trim(),
          // 0 clears an optional link (None = leave unchanged
          // server-side, so "" must map to the explicit clear).
          department_id: departmentId === "" ? 0 : Number(departmentId),
          vendor_id: vendorId === "" ? 0 : Number(vendorId),
          price,
          cost,
          is_taxable: taxable,
          item_number: itemNumber.trim(),
          size: size.trim(),
          // 0 clears the nullable case fields server-side.
          case_size: caseSizeNum > 0 ? caseSizeNum : 0,
          case_cost: caseCost > 0 ? caseCost : 0,
          is_ebt: ebt,
        });
      } else {
        await createItem({
          pos_code: posCode.trim(),
          pos_code_format: posFormat,
          name: name.trim(),
          department_id: departmentId === "" ? null : Number(departmentId),
          vendor_id: vendorId === "" ? null : Number(vendorId),
          price,
          cost,
          is_taxable: taxable,
          item_number: itemNumber.trim(),
          size: size.trim(),
          case_size: caseSizeNum > 0 ? caseSizeNum : null,
          case_cost: caseCost > 0 ? caseCost : null,
          is_ebt: ebt,
        });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("pb.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.modalForm}>
      {error && <Alert tone="error">{error}</Alert>}
      <div className={styles.fieldGrid}>
        <Field
          label={
            <>
              {t("posTx.colScanCode")}
              <InfoTip text={t("pb.scanTip")} />
            </>
          }
        >
          <Input
            type="text" value={posCode} required maxLength={30}
            onChange={(e) => setPosCode(e.target.value)}
          />
        </Field>
        <Field label={t("pb.codeType")}>
          <Select
            value={posFormat}
            onChange={(e) => setPosFormat(e.target.value)}
          >
            <option value="upc">{t("pb.upc")}</option>
            <option value="plu">{t("pb.plu")}</option>
          </Select>
        </Field>
      </div>
      <Field label={t("pb.itemName")}>
        <Input
          type="text" value={name} required maxLength={160}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className={styles.fieldGrid}>
        <Field label={t("pb.deptOptional")}>
          <Select
            value={parentSel}
            onChange={(e) => setDepartmentId(e.target.value)}
          >
            <option value="">{t("pb.noneOption")}</option>
            {parents.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("pb.subDept")}>
          <Select
            value={subSel}
            disabled={subs.length === 0}
            onChange={(e) =>
              setDepartmentId(e.target.value || parentSel)
            }
          >
            <option value="">
              {subs.length === 0 ? "—" : t("pb.noneOption")}
            </option>
            {subs.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("pb.vendorOptional")}>
          <Select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
          >
            <option value="">{t("pb.noneOption")}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </Select>
        </Field>
        <Field label={t("pb.salesTax")}>
          <Checkbox checked={taxable} onChange={setTaxable}>
            {t("pb.taxable")}
          </Checkbox>
        </Field>
        <Field label={t("pb.itemNumber")}>
          <Input
            type="text" value={itemNumber} maxLength={40}
            placeholder={t("pb.itemNumberPlaceholder")}
            onChange={(e) => setItemNumber(e.target.value)}
          />
        </Field>
        <Field label={t("pb.size")}>
          <Input
            type="text" value={size} maxLength={40}
            placeholder={t("pb.sizePlaceholder")}
            onChange={(e) => setSize(e.target.value)}
          />
        </Field>
        <Field label={t("pb.caseSize")}>
          <Input
            type="number" min={0} step="1" value={caseSize}
            placeholder={t("pb.caseSizePlaceholder")}
            onChange={(e) => setCaseSize(e.target.value)}
          />
        </Field>
        {/* Money fields carry their own label + hint: <MoneyInput> is
            a <label> itself, so it never sits inside a <Field>. */}
        <MoneyInput
          label={t("pb.caseCost")}
          hint={
            unitFromCase != null
              ? t("pb.unitFromCase", { amount: `$${unitFromCase.toFixed(4)}` })
              : undefined
          }
          value={caseCost} onChange={setCaseCost} fullWidth
        />
        <div className={styles.moneyWithAction}>
          <MoneyInput
            label={t("pb.unitCost")}
            hint={
              unitFromCase != null && cost === 0
                ? t("pb.unitEmpty")
                : undefined
            }
            value={cost} onChange={setCost} fullWidth
            style={{ flex: 1, minWidth: 0 }}
          />
          {unitFromCase != null && (
            <Button
              type="button" tone="secondary" size="sm"
              onClick={() => setCost(Number(unitFromCase.toFixed(2)))}
            >
              {t("pb.useCase")}
            </Button>
          )}
        </div>
        <MoneyInput
          label={t("pb.retail")}
          hint={
            margin != null
              ? t("pb.margin", { pct: margin.toFixed(2) })
              : undefined
          }
          value={price} onChange={setPrice} required fullWidth
        />
        <Field
          label={t("pb.marginGoal")}
          hint={t("pb.marginHint")}
        >
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <Input
              type="number" min={0} max={99} step="0.01"
              value={marginGoal}
              placeholder={t("pb.marginPlaceholder")}
              onChange={(e) => setMarginGoal(e.target.value)}
            />
            <Button
              type="button" tone="secondary" size="sm"
              disabled={
                cost <= 0
                || !(Number.parseFloat(marginGoal) > 0)
                || Number.parseFloat(marginGoal) >= 100
              }
              onClick={() => {
                const g = Number.parseFloat(marginGoal);
                setPrice(Number((cost / (1 - g / 100)).toFixed(2)));
              }}
            >
              {t("pb.apply")}
            </Button>
          </div>
        </Field>
      </div>
      <Checkbox
        checked={ebt} onChange={setEbt}
        style={{ marginTop: "0.75rem" }}
      >
        {t("pb.ebt")}
      </Checkbox>
      <ModalActions>
        <Button tone="secondary" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy} disabled={busy}>
          {existing ? t("common.saveChanges") : t("pb.addItemButton")}
        </Button>
      </ModalActions>
    </form>
  );
}

// ── Vendors tab ──────────────────────────────────────────────

function VendorsTab() {
  useT(); // re-render on a language switch
  const canManage = hasPermission("catalog", "update");
  const [showInactive, setShowInactive] = useState(false);
  const vendors = useVendors(showInactive);
  const qc = useQueryClient();
  const toastApiError = useApiErrorToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Vendor | null>(null);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["catalog"] });
  }

  async function toggleActive(v: Vendor) {
    try {
      await updateVendor(v.id, { is_active: !v.is_active });
      refresh();
    } catch (err) {
      toastApiError(err, t("pb.vendorFailed"));
    }
  }

  return (
    <Section
      title={t("pb.tabVendors")}
      actions={
        canManage ? (
          <div className={styles.toolbarActions}>
            <Button
              size="sm" tone="secondary"
              onClick={() => setShowInactive((v) => !v)}
            >
              {showInactive ? t("dept.hideInactive") : t("dept.showInactive")}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              {t("pb.addVendor")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {vendors.isLoading && <Loading />}
      {vendors.isError && (
        <ErrorState
          message={t("pb.vendorsFailed")}
          onRetry={() => { void vendors.refetch(); }}
        />
      )}
      {vendors.data && vendors.data.vendors.length === 0 && (
        <EmptyState
          title={t("pb.noVendors")}
          body={
            canManage
              ? t("pb.noVendorsManage")
              : t("pb.noVendorsView")
          }
          cta={
            canManage ? (
              <Button size="sm" onClick={() => setAdding(true)}>
                {t("pb.addVendor")}
              </Button>
            ) : undefined
          }
        />
      )}
      {vendors.data && vendors.data.vendors.length > 0 && (
        <Card>
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  {[...VENDOR_COLUMNS,
                    ...(canManage ? ["common.actions" as const] : [])].map((h) => (
                    <th key={h} style={thStyle}>{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vendors.data.vendors.map((v) => (
                  <tr key={v.id}>
                    <td style={tdStyle}>{v.name}</td>
                    <td style={tdStyle}>{v.contact_name || "—"}</td>
                    <td style={tdStyle}>{v.phone || "—"}</td>
                    <td style={tdStyle}>
                      {v.account_number
                        ? (
                          <span className={styles.posCode}>
                            {v.account_number}
                          </span>
                        )
                        : "—"}
                    </td>
                    <td style={tdStyle}>{v.item_count}</td>
                    <td style={tdStyle}>
                      <Pill tone={v.is_active ? "accent" : "neutral"}>
                        {v.is_active ? t("dept.active") : t("dept.inactive")}
                      </Pill>
                    </td>
                    {canManage && (
                      <td style={tdStyle}>
                        <RowActions
                          title={v.name}
                          actions={[
                            {
                              label: t("common.edit"),
                              tone: "primary",
                              onClick: () => setEditing(v),
                            },
                            {
                              label: v.is_active
                                ? t("dept.deactivate") : t("dept.reactivate"),
                              tone: v.is_active ? "warning" : "primary",
                              onClick: () => toggleActive(v),
                            },
                          ]}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <VendorModal
        open={adding || editing != null}
        existing={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); refresh(); }}
      />
    </Section>
  );
}

function VendorModal({
  open, existing, onClose, onDone,
}: {
  open: boolean;
  existing: Vendor | null;
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? t("pb.editRow", { name: existing.name }) : t("pb.addVendorTitle")}
    >
      {open && (
        // Keyed remount resets the form per open/target — prefill
        // via initializers, no state-sync effect needed.
        <VendorForm
          key={existing?.id ?? "new"}
          existing={existing}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

function VendorForm({
  existing, onClose, onDone,
}: {
  existing: Vendor | null;
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [name, setName] = useState(existing?.name ?? "");
  const [contact, setContact] = useState(existing?.contact_name ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [account, setAccount] = useState(existing?.account_number ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      contact_name: contact.trim(),
      phone: phone.trim(),
      email: email.trim(),
      account_number: account.trim(),
      notes: notes.trim(),
    };
    try {
      if (existing) {
        await updateVendor(existing.id, body);
      } else {
        await createVendor(body);
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("pb.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.modalForm}>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={t("pb.vendorName")}>
        <Input
          type="text" value={name} required maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className={styles.fieldGrid}>
        <Field label={t("pb.contact")}>
          <Input
            type="text" value={contact} maxLength={120}
            onChange={(e) => setContact(e.target.value)}
          />
        </Field>
        <Field label={t("pb.phone")}>
          <Input
            type="tel" value={phone} maxLength={30}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        <Field label={t("pb.email")}>
          <Input
            type="email" value={email} maxLength={200}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label={
            <>
              {t("pb.account")}
              <InfoTip text={t("pb.accountTip")} />
            </>
          }
        >
          <Input
            type="text" value={account} maxLength={60}
            onChange={(e) => setAccount(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t("pb.notes")}>
        <Input
          type="text" value={notes} maxLength={500}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <ModalActions>
        <Button tone="secondary" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy} disabled={busy}>
          {existing ? t("common.saveChanges") : t("pb.addVendorButton")}
        </Button>
      </ModalActions>
    </form>
  );
}

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createDepartment, updateDepartment, useDepartments,
  type Department, type DepartmentType,
} from "../api/dayclose";
import { ApiError, apiErrorMessage } from "../lib/api";
import { canDo } from "../lib/access";
import { fmtNumber } from "../lib/formatters";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import {
  Alert, Button, Checkbox, DataTable, EmptyState, ErrorState, Field,
  InfoTip, Input, Loading, Modal, ModalActions, Pill, RowActions, Section,
  Select, useToast,
  type DataColumn,
} from "./ui";
import styles from "./DepartmentsManager.module.css";
import { t, tn, useT, type MessageKey } from "../i18n";

// The store's department setup (Account → Departments; the same
// component is the Price book's Departments tab). Modelled on
// Modisoft's Setup → Departments: each department has the register's
// department number ("POS no"), a type (what kind of sales it holds —
// the daily paperwork reads it), taxable, a minimum buyer age and a
// NACS product code. The register number is the register-import
// mapping itself, so setting it here is what tells the import which
// department a sale belongs to.

const EDIT_PERM = "day_close.update";

// Offered as a one-click prefill on the empty catalog — never
// auto-seeded. The operator owns the catalog (HANDOFF.md §2 product
// principle): prefills are a starting point to edit, not a fixed
// vocabulary. Created in the reader's language: once saved they are
// the store's own names, typed text like any other.
const STARTER_DEPARTMENTS: {
  name: MessageKey;
  extra?: { department_type?: DepartmentType; is_taxable?: boolean; min_age?: number };
}[] = [
  { name: "dept.starter.grocery" },
  { name: "dept.starter.beverages" },
  { name: "dept.starter.snacks" },
  { name: "dept.starter.tobacco", extra: { min_age: 21 } },
  { name: "dept.starter.beer", extra: { min_age: 21 } },
  { name: "dept.starter.deli" },
  {
    name: "dept.starter.lottery",
    extra: { department_type: "lottery_sell", is_taxable: false, min_age: 18 },
  },
  { name: "dept.starter.other" },
];

// The type picker, grouped the way Modisoft groups department types.
const TYPE_GROUPS: { label: MessageKey; types: DepartmentType[] }[] = [
  { label: "dept.group.merchandise", types: ["merchandise"] },
  { label: "dept.group.fuel", types: ["fuel"] },
  { label: "dept.group.lottery", types: ["lottery_sell", "lottery_cash", "lotto_sell", "lotto_cash"] },
  {
    label: "dept.group.services",
    types: [
      "money_order", "money_order_fee", "money_transfer",
      "money_transfer_fee", "check_cash_fee", "service",
    ],
  },
  { label: "dept.group.misc", types: ["misc"] },
];

const TYPE_LABEL: Record<DepartmentType, MessageKey> = {
  merchandise: "dept.type.merchandise",
  fuel: "dept.type.fuel",
  lottery_sell: "dept.type.lottery_sell",
  lottery_cash: "dept.type.lottery_cash",
  lotto_sell: "dept.type.lotto_sell",
  lotto_cash: "dept.type.lotto_cash",
  money_order: "dept.type.money_order",
  money_order_fee: "dept.type.money_order_fee",
  money_transfer: "dept.type.money_transfer",
  money_transfer_fee: "dept.type.money_transfer_fee",
  check_cash_fee: "dept.type.check_cash_fee",
  service: "dept.type.service",
  misc: "dept.type.misc",
};

// One line under the picker: what a department of this type holds.
const TYPE_HINT: Record<DepartmentType, MessageKey> = {
  merchandise: "dept.typeHint.merchandise",
  fuel: "dept.typeHint.fuel",
  lottery_sell: "dept.typeHint.lottery_sell",
  lottery_cash: "dept.typeHint.lottery_cash",
  lotto_sell: "dept.typeHint.lotto_sell",
  lotto_cash: "dept.typeHint.lotto_cash",
  money_order: "dept.typeHint.money_order",
  money_order_fee: "dept.typeHint.money_order_fee",
  money_transfer: "dept.typeHint.money_transfer",
  money_transfer_fee: "dept.typeHint.money_transfer_fee",
  check_cash_fee: "dept.typeHint.check_cash_fee",
  service: "dept.typeHint.service",
  misc: "dept.typeHint.misc",
};

const POS_CODE = /^[0-9A-Za-z]{1,20}$/;
const NACS_CODE = /^[0-9A-Za-z]{0,10}$/;

/** "4, 104" → ["4", "104"]; commas or spaces separate, blanks drop. */
function parsePosCodes(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\s,]+/)) {
    const code = part.trim();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

function posSortValue(d: Department): number {
  const first = d.pos_codes.find((c) => /^\d+$/.test(c));
  return first == null ? Number.POSITIVE_INFINITY : Number(first);
}

type SortKey = "pos" | "name" | "type";

export default function DepartmentsManager({
  showTitle = true,
}: {
  /** The Account page carries the title in its own header. */
  showTitle?: boolean;
} = {}) {
  useT(); // re-render on a language switch
  const [showInactive, setShowInactive] = useState(false);
  const departments = useDepartments(showInactive);
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | DepartmentType>("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>(
    { key: "name", direction: "asc" },
  );
  const canEdit = canDo(EDIT_PERM);
  const all = departments.data?.departments;

  const rows = useMemo(() => {
    if (!all) return undefined;
    const q = query.trim().toLowerCase();
    const filtered = all.filter((d) => {
      if (typeFilter && d.department_type !== typeFilter) return false;
      if (!q) return true;
      return (
        d.name.toLowerCase().includes(q)
        || d.parent_name.toLowerCase().includes(q)
        || d.pos_codes.some((c) => c.toLowerCase().includes(q))
        || t(TYPE_LABEL[d.department_type]).toLowerCase().includes(q)
      );
    });
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sort.key === "pos") cmp = posSortValue(a) - posSortValue(b);
      else if (sort.key === "type") {
        cmp = t(TYPE_LABEL[a.department_type]).localeCompare(t(TYPE_LABEL[b.department_type]));
      }
      if (cmp === 0 || Number.isNaN(cmp)) cmp = a.name.localeCompare(b.name);
      return cmp * dir;
    });
  }, [all, query, typeFilter, sort]);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["dayclose"] });
  }

  async function addStarterSet() {
    setSeeding(true);
    try {
      for (const [i, item] of STARTER_DEPARTMENTS.entries()) {
        await createDepartment({
          name: t(item.name), sort_order: (i + 1) * 10, ...item.extra,
        });
      }
      refresh();
      toast({ message: t("dept.starterAdded"), tone: "success" });
    } catch (err) {
      refresh();
      toastApiError(err, t("dept.starterFailed"));
    } finally {
      setSeeding(false);
    }
  }

  async function toggleActive(d: Department) {
    try {
      await updateDepartment(d.id, { is_active: !d.is_active });
      refresh();
    } catch (err) {
      toastApiError(err, t("dept.updateFailed"));
    }
  }

  const columns: DataColumn<Department>[] = [
    {
      key: "pos", header: t("dept.colPos"), label: t("dept.colPos"), sortKey: "pos",
      render: (d) => (d.pos_codes.length
        ? <span className={styles.code}>{d.pos_codes.join(", ")}</span>
        : <span className={styles.muted}>—</span>),
    },
    {
      key: "name", header: t("dept.colDepartment"), label: t("dept.colDepartment"), sortKey: "name",
      render: (d) => (
        <span className={styles.nameCell}>
          <span>{d.name}</span>
          {d.parent_name && (
            <span className={styles.sub}>{t("dept.underParent", { name: d.parent_name })}</span>
          )}
        </span>
      ),
    },
    {
      key: "type", header: t("dept.colType"), label: t("dept.colType"), sortKey: "type",
      render: (d) => t(TYPE_LABEL[d.department_type]),
    },
    {
      key: "tax", header: t("dept.colTax"), label: t("dept.colTax"),
      render: (d) => (d.is_taxable ? t("dept.taxable") : t("dept.nonTaxable")),
    },
    {
      key: "age", header: t("dept.colAge"), label: t("dept.colAge"),
      render: (d) => (d.min_age
        ? t("dept.agePlus", { age: String(d.min_age) })
        : <span className={styles.muted}>—</span>),
    },
    {
      key: "nacs", header: t("dept.colNacs"), label: t("dept.colNacs"),
      render: (d) => (d.nacs_code
        ? <span className={styles.code}>{d.nacs_code}</span>
        : <span className={styles.muted}>—</span>),
    },
    {
      key: "status", header: t("common.status"), label: t("common.status"),
      render: (d) => (
        <Pill tone={d.is_active ? "accent" : "neutral"}>
          {d.is_active ? t("dept.active") : t("dept.inactive")}
        </Pill>
      ),
    },
    {
      key: "actions", header: t("common.actions"), label: t("common.actions"), align: "right",
      render: (d) => (
        <RowActions
          title={d.name}
          actions={[
            {
              label: t("common.edit"),
              perm: EDIT_PERM,
              tone: "primary",
              onClick: () => setEditing(d),
            },
            {
              label: d.is_active ? t("dept.deactivate") : t("dept.reactivate"),
              perm: EDIT_PERM,
              tone: d.is_active ? "warning" : "primary",
              onClick: () => toggleActive(d),
            },
          ]}
        />
      ),
    },
  ];

  const empty = all != null && all.length === 0;

  return (
    <Section
      title={showTitle ? (
        <>
          {t("dept.title")}
          <InfoTip text={t("dept.tip")} />
        </>
      ) : undefined}
      actions={
        <div className={styles.actions}>
          <Button
            size="sm" tone="secondary"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? t("dept.hideInactive") : t("dept.showInactive")}
          </Button>
          <Button size="sm" perm={EDIT_PERM} onClick={() => setAdding(true)}>
            {t("dept.add")}
          </Button>
        </div>
      }
    >
      {departments.isLoading && <Loading />}
      {departments.isError && (
        <ErrorState
          message={t("dept.loadFailed")}
          onRetry={() => { void departments.refetch(); }}
        />
      )}
      {empty && (
        <EmptyState
          title={t("dept.empty")}
          body={t("dept.emptyBody")}
          cta={
            <Button size="sm" perm={EDIT_PERM} busy={seeding} disabled={seeding}
              onClick={() => { void addStarterSet(); }}
            >
              {t("dept.addStarter")}
            </Button>
          }
        />
      )}
      {all != null && !empty && (
        <>
          <div className={styles.toolbar}>
            <Input
              className={styles.search}
              type="search"
              value={query}
              aria-label={t("dept.search")}
              placeholder={t("dept.searchPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              className={styles.typeFilter}
              aria-label={t("dept.typeFilter")}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as "" | DepartmentType)}
            >
              <option value="">{t("dept.allTypes")}</option>
              <TypeOptions />
            </Select>
            <span className={styles.count}>
              {tn("dept.count", rows?.length ?? 0, fmtNumber)}
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(d) => d.id}
            onRowClick={canEdit ? (d) => setEditing(d) : undefined}
            rowLabel={(d) => t("dept.editTitle", { name: d.name })}
            emptyTitle={t("dept.noMatch")}
            emptyBody={t("dept.noMatchBody")}
            sort={{
              key: sort.key,
              direction: sort.direction,
              onSort: (key, direction) => setSort({ key: key as SortKey, direction }),
            }}
          />
        </>
      )}
      <DepartmentModal
        open={adding || editing != null}
        existing={editing}
        departments={all ?? []}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); refresh(); }}
      />
    </Section>
  );
}

function TypeOptions() {
  useT();
  return (
    <>
      {TYPE_GROUPS.map((g) => (
        <optgroup key={g.label} label={t(g.label)}>
          {g.types.map((ty) => (
            <option key={ty} value={ty}>{t(TYPE_LABEL[ty])}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

function DepartmentModal({
  open, existing, departments, onClose, onDone,
}: {
  open: boolean;
  existing: Department | null;
  departments: Department[];
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={existing ? t("dept.editTitle", { name: existing.name }) : t("dept.addTitle")}
    >
      {open && (
        // Keyed remount resets the form per open/target — prefill
        // via initializers, no state-sync effect needed.
        <DepartmentForm
          key={existing?.id ?? "new"}
          existing={existing}
          departments={departments}
          onClose={onClose}
          onDone={onDone}
        />
      )}
    </Modal>
  );
}

const AGE_CHOICES = ["", "18", "21"];

function DepartmentForm({
  existing, departments, onClose, onDone,
}: {
  existing: Department | null;
  departments: Department[];
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [name, setName] = useState(existing?.name ?? "");
  const [posText, setPosText] = useState(existing?.pos_codes.join(", ") ?? "");
  const [type, setType] = useState<DepartmentType>(existing?.department_type ?? "merchandise");
  const [taxable, setTaxable] = useState(existing?.is_taxable ?? true);
  // A new department follows its type's usual tax setting until the
  // person ticks the box themselves; a saved one keeps what it has.
  const [taxTouched, setTaxTouched] = useState(existing != null);
  const [minAge, setMinAge] = useState(existing?.min_age ? String(existing.min_age) : "");
  const [nacs, setNacs] = useState(existing?.nacs_code ?? "");
  const [sortOrder, setSortOrder] = useState(String(existing?.sort_order ?? 0));
  const [parentId, setParentId] = useState(
    existing?.parent_id != null ? String(existing.parent_id) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posError, setPosError] = useState<string | null>(null);
  const [nacsError, setNacsError] = useState<string | null>(null);

  // Valid parents: top-level departments other than this one
  // (sub-departments go one level deep — the server enforces it,
  // the picker just doesn't offer invalid choices).
  const parentChoices = departments.filter(
    (d) => d.parent_id == null && d.id !== existing?.id,
  );
  const ageChoices = minAge && !AGE_CHOICES.includes(minAge)
    ? [...AGE_CHOICES, minAge] : AGE_CHOICES;

  function onTypeChange(next: DepartmentType) {
    setType(next);
    if (!taxTouched) setTaxable(next === "merchandise");
  }

  function checkPos(text: string): string | null {
    const codes = parsePosCodes(text);
    const bad = codes.find((c) => !POS_CODE.test(c));
    if (bad) return t("dept.posInvalid", { code: bad });
    for (const code of codes) {
      const owner = departments.find(
        (d) => d.id !== existing?.id && d.pos_codes.includes(code),
      );
      if (owner) return t("dept.posTaken", { code, name: owner.name });
    }
    return null;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pErr = checkPos(posText);
    const nErr = NACS_CODE.test(nacs.trim()) ? null : t("dept.nacsInvalid");
    setPosError(pErr);
    setNacsError(nErr);
    if (pErr || nErr) return;
    setBusy(true);
    setError(null);
    const common = {
      name: name.trim(),
      sort_order: Number.parseInt(sortOrder, 10) || 0,
      department_type: type,
      is_taxable: taxable,
      nacs_code: nacs.trim(),
      pos_codes: parsePosCodes(posText),
    };
    try {
      if (existing) {
        await updateDepartment(existing.id, {
          ...common,
          // 0 clears the parent link / the age limit (PATCH semantics).
          parent_id: parentId === "" ? 0 : Number(parentId),
          min_age: minAge === "" ? 0 : Number(minAge),
        });
      } else {
        await createDepartment({
          ...common,
          parent_id: parentId === "" ? null : Number(parentId),
          min_age: minAge === "" ? null : Number(minAge),
        });
      }
      onDone();
    } catch (err) {
      const message = apiErrorMessage(err, t("dept.saveFailed"));
      // A register number held by another department belongs under
      // that field, not in a banner.
      if (err instanceof ApiError && err.status === 409 && /^POS dept no/.test(err.message)) {
        setPosError(message);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.modalForm} noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      <div className={styles.formGrid}>
        <div className={styles.full}>
          <Field label={t("common.name")}>
            <Input
              type="text" value={name} required maxLength={80} autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <Field
          label={
            <>
              {t("dept.posNo")}
              <InfoTip text={t("dept.posTip")} />
            </>
          }
          hint={t("dept.posHint")}
          error={posError}
        >
          <Input
            type="text" inputMode="numeric" value={posText} maxLength={200}
            className={styles.code}
            onChange={(e) => { setPosText(e.target.value); setPosError(null); }}
            onBlur={() => setPosError(checkPos(posText))}
          />
        </Field>
        <Field label={t("dept.typeLabel")} hint={t(TYPE_HINT[type])}>
          <Select
            value={type}
            onChange={(e) => onTypeChange(e.target.value as DepartmentType)}
          >
            <TypeOptions />
          </Select>
        </Field>

        <p className={styles.groupTitle}>{t("dept.salesRules")}</p>
        <div className={styles.full}>
          <Checkbox
            checked={taxable}
            onChange={(next) => { setTaxable(next); setTaxTouched(true); }}
          >
            {t("dept.taxableLabel")}
          </Checkbox>
        </div>
        <Field label={t("dept.minAge")}>
          <Select value={minAge} onChange={(e) => setMinAge(e.target.value)}>
            {ageChoices.map((a) => (
              <option key={a || "none"} value={a}>
                {a ? t("dept.agePlus", { age: a }) : t("dept.noRestriction")}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={
            <>
              {t("dept.nacs")}
              <InfoTip text={t("dept.nacsTip")} />
            </>
          }
          error={nacsError}
        >
          <Input
            type="text" inputMode="numeric" value={nacs} maxLength={10}
            className={styles.code}
            onChange={(e) => { setNacs(e.target.value); setNacsError(null); }}
          />
        </Field>

        <p className={styles.groupTitle}>{t("dept.organize")}</p>
        <Field
          label={
            <>
              {t("dept.parent")}
              <InfoTip text={t("dept.parentTip")} />
            </>
          }
        >
          <Select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
          >
            <option value="">{t("dept.none")}</option>
            {parentChoices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </Select>
        </Field>
        <Field
          label={
            <>
              {t("dept.sortOrder")}
              <InfoTip text={t("dept.sortTip")} />
            </>
          }
        >
          <Input
            type="number" min={0} value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </Field>
      </div>
      <ModalActions>
        <Button tone="secondary" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy} disabled={busy || !name.trim()}>
          {existing ? t("common.saveChanges") : t("dept.addButton")}
        </Button>
      </ModalActions>
    </form>
  );
}

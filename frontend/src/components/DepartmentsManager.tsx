import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  createDepartment, updateDepartment, useDepartments,
  type Department,
} from "../api/dayclose";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import {
  Alert, Button, Card, EmptyState, ErrorState, Field, InfoTip, Input,
  Loading, Modal, Pill, RowActions, Section, Select, Table,
  tdStyle, thStyle, useToast,
  ModalActions,
} from "./ui";
import styles from "./DepartmentsManager.module.css";
import { t, useT, type MessageKey } from "../i18n";

// The store's department catalog. Departments group sales lines on a
// register close AND classify price-book items, so the catalog lives
// with the price book rather than on a close-out screen — it is
// reference data the operator maintains once, not something they
// touch every night.

// Offered as a one-click prefill on the empty catalog — never
// auto-seeded. The operator owns the catalog (HANDOFF.md §2 product
// principle): prefills are a starting point to edit, not a fixed
// vocabulary.
// Created in the reader's language: once saved they are the store's
// own names, typed text like any other.
const STARTER_DEPARTMENTS: MessageKey[] = [
  "dept.starter.grocery", "dept.starter.beverages", "dept.starter.snacks",
  "dept.starter.tobacco", "dept.starter.beer", "dept.starter.deli",
  "dept.starter.lottery", "dept.starter.other",
];
const DEPT_COLUMNS: MessageKey[] = [
  "dept.colDepartment", "dept.colParent", "dept.colSort", "common.status", "common.actions",
];

export default function DepartmentsManager() {
  useT(); // re-render on a language switch
  const [showInactive, setShowInactive] = useState(false);
  const departments = useDepartments(showInactive);
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [seeding, setSeeding] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["dayclose"] });
  }

  async function addStarterSet() {
    setSeeding(true);
    try {
      for (const [i, key] of STARTER_DEPARTMENTS.entries()) {
        await createDepartment({ name: t(key), sort_order: (i + 1) * 10 });
      }
      refresh();
      toast({
        message: t("dept.starterAdded"),
        tone: "success",
      });
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

  return (
    <Section
      title={
        <>
          {t("dept.title")}
          <InfoTip text={t("dept.tip")} />
        </>
      }
      actions={
        <div className={styles.actions}>
          <Button
            size="sm" tone="secondary"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? t("dept.hideInactive") : t("dept.showInactive")}
          </Button>
          <Button size="sm" perm="day_close.update" onClick={() => setAdding(true)}>
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
      {departments.data && departments.data.departments.length === 0 && (
        <EmptyState
          title={t("dept.empty")}
          body={t("dept.emptyBody")}
          cta={
            <Button size="sm" busy={seeding} disabled={seeding}
              onClick={() => { void addStarterSet(); }}
            >
              {t("dept.addStarter")}
            </Button>
          }
        />
      )}
      {departments.data && departments.data.departments.length > 0 && (
        <Card>
          <Table>
            <thead>
              <tr>
                {DEPT_COLUMNS.map(
                  (h) => <th key={h} style={thStyle}>{t(h)}</th>,
                )}
              </tr>
            </thead>
            <tbody>
              {departments.data.departments.map((d) => (
                <tr key={d.id}>
                  <td style={tdStyle}>{d.name}</td>
                  <td style={tdStyle}>{d.parent_name || "—"}</td>
                  <td style={tdStyle}>{d.sort_order}</td>
                  <td style={tdStyle}>
                    <Pill tone={d.is_active ? "accent" : "neutral"}>
                      {d.is_active ? t("dept.active") : t("dept.inactive")}
                    </Pill>
                  </td>
                  <td style={tdStyle}>
                    <RowActions
                      title={d.name}
                      actions={[
                        {
                          label: t("common.edit"),
                          perm: "day_close.update",
                          tone: "primary",
                          onClick: () => setEditing(d),
                        },
                        {
                          label: d.is_active ? t("dept.deactivate") : t("dept.reactivate"),
                          perm: "day_close.update",
                          tone: d.is_active ? "warning" : "primary",
                          onClick: () => toggleActive(d),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <DepartmentModal
        open={adding || editing != null}
        existing={editing}
        departments={departments.data?.departments ?? []}
        onClose={() => { setAdding(false); setEditing(null); }}
        onDone={() => { setAdding(false); setEditing(null); refresh(); }}
      />
    </Section>
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
  const [sortOrder, setSortOrder] = useState(
    String(existing?.sort_order ?? 0),
  );
  const [parentId, setParentId] = useState(
    existing?.parent_id != null ? String(existing.parent_id) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Valid parents: top-level departments other than this one
  // (sub-departments go one level deep — the server enforces it,
  // the picker just doesn't offer invalid choices).
  const parentChoices = departments.filter(
    (d) => d.parent_id == null && d.id !== existing?.id,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      name: name.trim(),
      sort_order: Number.parseInt(sortOrder, 10) || 0,
    };
    try {
      if (existing) {
        await updateDepartment(existing.id, {
          ...body,
          // 0 clears the parent link (server PATCH semantics).
          parent_id: parentId === "" ? 0 : Number(parentId),
        });
      } else {
        await createDepartment({
          ...body,
          parent_id: parentId === "" ? null : Number(parentId),
        });
      }
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("dept.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={styles.modalForm}>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={t("common.name")}>
        <Input
          type="text" value={name} required maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
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
      <ModalActions>
        <Button tone="secondary" type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy} disabled={busy}>
          {existing ? t("common.saveChanges") : t("dept.addButton")}
        </Button>
      </ModalActions>
    </form>
  );
}

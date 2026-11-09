import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  addCheckCustomerId, createCheckCustomer, deleteCheckCustomerId, EMPTY_ID, feeLabel,
  idTypeLabel, updateCheckCustomer, updateCheckCustomerId, useCheckCustomer,
  type CheckCustomerDetail, type CheckCustomerIdBody, type CheckCustomerIdRow,
} from "../api/checkCashing";
import {
  IdFields, PartyRulesFields, PartyStatusPill, type PartyRules,
} from "../components/CheckCashingFields";
import { CheckActivity } from "../components/CheckActivity";
import { DeskColumns, DeskForm, DeskPage, DeskPane } from "../components/DeskPage";
import { PageCrumbs } from "../components/PageCrumbs";
import {
  Alert, Button, Card, ConfirmDialog, DateInput, ErrorState, Field, FormActions,
  Input, Loading, Modal, ModalActions, PageHeader, Pill, SectionTitle,
  Textarea, useToast,
} from "../components/ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { hasPermission } from "../lib/permissions";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./CheckCashing.module.css";

// Check cashing app → Customers → New customer / a customer's
// profile (/app/check-cashing/customers/new, /:id). A new customer is
// saved with at least one ID; on the profile, IDs are added, edited
// and removed one at a time (the last one always stays). Status and an
// own fee are for people with "Manage check cashing".

interface Profile {
  full_name: string;
  dob: string;
  phone_country: string;
  phone_number: string;
  address: string;
  notes: string;
}

const EMPTY_PROFILE: Profile = {
  full_name: "", dob: "", phone_country: "+1", phone_number: "", address: "", notes: "",
};
const EMPTY_RULES: PartyRules = {
  status: "normal", status_reason: "", fee_kind: null, fee_value: null,
};

function fromDetail(c: CheckCustomerDetail): { profile: Profile; rules: PartyRules } {
  return {
    profile: {
      full_name: c.full_name, dob: c.dob ?? "", phone_country: c.phone_country,
      phone_number: c.phone_number, address: c.address, notes: c.notes,
    },
    rules: {
      status: c.status as PartyRules["status"], status_reason: c.status_reason,
      fee_kind: (c.fee_kind as PartyRules["fee_kind"]) ?? null,
      fee_value: c.fee_value ?? null,
    },
  };
}

export default function CheckCustomerForm() {
  const t = useT();
  const { id } = useParams<{ id?: string }>();
  const isEdit = id !== undefined;
  const customerId = isEdit ? Number(id) : NaN;
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const canManage = hasPermission("check_cashing_manage", "update");
  const canEdit = hasPermission("check_cashing", isEdit ? "update" : "create");

  const detail = useCheckCustomer(isEdit ? customerId : undefined);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [rules, setRules] = useState<PartyRules>(EMPTY_RULES);
  const [ids, setIds] = useState<CheckCustomerIdBody[]>([{ ...EMPTY_ID }]);
  const [baseline, setBaseline] = useState<string>(
    JSON.stringify({ profile: EMPTY_PROFILE, rules: EMPTY_RULES, ids: [EMPTY_ID] }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !detail.data) return;
    const next = fromDetail(detail.data.customer);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the editable form + dirty baseline from the fetched profile
    setProfile(next.profile);
    setRules(next.rules);
    setBaseline(JSON.stringify({ ...next, ids: [EMPTY_ID] }));
  }, [isEdit, detail.data]);

  const snapshot = JSON.stringify({ profile, rules, ids: isEdit ? [EMPTY_ID] : ids });
  const guard = useUnsavedGuard(snapshot !== baseline && !busy, {
    message: t("checkCashing.unsavedCustomer"),
  });

  function setP<K extends keyof Profile>(key: K, value: Profile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  function backToList() {
    navigate("/check-cashing/customers", { replace: true });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const body = {
      ...profile,
      full_name: profile.full_name.trim(),
      dob: profile.dob || null,
      ...rules,
    };
    try {
      if (isEdit) {
        const res = await updateCheckCustomer(customerId, body);
        const next = fromDetail(res.customer);
        setBaseline(JSON.stringify({ ...next, ids: [EMPTY_ID] }));
        toast({ message: t("checkCashing.customerSaved"), tone: "success" });
      } else {
        const res = await createCheckCustomer({ ...body, ids });
        toast({ message: t("checkCashing.customerAdded"), tone: "success" });
        guard.proceed(() => navigate(
          `/check-cashing/customers/${res.customer.id}`, { replace: true },
        ));
      }
      void queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  const title = isEdit
    ? detail.data?.customer.full_name || t("checkCashing.customerTitle")
    : t("checkCashing.newCustomer");

  if (identity?.store_id == null) {
    return (
      <DeskPage>
        <PageHeader title={title} />
        <p>{t("checkCashing.signIn")}</p>
      </DeskPage>
    );
  }
  if (isEdit && detail.isError && !detail.data) {
    return (
      <DeskPage>
        <PageCrumbs current={t("checkCashing.customerTitle")} />
        <PageHeader title={t("checkCashing.customerTitle")} />
        <ErrorState
          message={apiErrorMessage(detail.error, t("checkCashing.loadFailed"))}
          onRetry={() => void detail.refetch()}
          busy={detail.isFetching}
        />
      </DeskPage>
    );
  }
  if (isEdit && !detail.data) {
    return <DeskPage><Loading /></DeskPage>;
  }

  const customer = detail.data?.customer;
  const saveDisabled = busy || !profile.full_name.trim()
    || (!isEdit && ids.some((i) => !i.id_number.trim()));

  return (
    <DeskPage>
      <PageCrumbs current={isEdit ? title : t("checkCashing.newCustomer")} />
      <PageHeader
        title={title}
        subtitle={customer ? (
          <span className={styles.statusCell}>
            <PartyStatusPill status={customer.status} />
            {customer.home_store_name && (
              <span className={styles.muted}>
                {t("checkCashing.addedAt", { store: customer.home_store_name })}
              </span>
            )}
          </span>
        ) : t("checkCashing.newCustomerSubtitle")}
      />

      <DeskColumns>
      <DeskForm onSubmit={onSubmit}>
        <DeskPane>
        <fieldset disabled={!canEdit} className={`${styles.fieldset} ds-form`}>
          <Card>
            <SectionTitle>{t("checkCashing.profile")}</SectionTitle>
            <div className={styles.fieldGrid}>
              <Field label={t("checkCashing.fullName")}>
                <Input
                  type="text" required maxLength={120}
                  value={profile.full_name}
                  onChange={(e) => setP("full_name", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.dob")}>
                <DateInput
                  value={profile.dob}
                  onChange={(e) => setP("dob", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.phoneCountry")}>
                <Input
                  type="text" maxLength={8} placeholder="+1"
                  value={profile.phone_country}
                  onChange={(e) => setP("phone_country", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.phone")}>
                <Input
                  type="tel" maxLength={40}
                  value={profile.phone_number}
                  onChange={(e) => setP("phone_number", e.target.value)}
                />
              </Field>
              <Field label={t("checkCashing.address")} style={{ gridColumn: "1 / -1" }}>
                <Input
                  type="text" maxLength={255}
                  value={profile.address}
                  onChange={(e) => setP("address", e.target.value)}
                />
              </Field>
            </div>
            <Field label={t("checkCashing.notes")}>
              <Textarea
                rows={3} maxLength={4000}
                value={profile.notes}
                onChange={(e) => setP("notes", e.target.value)}
              />
            </Field>
          </Card>

          {!isEdit && (
            <Card>
              <SectionTitle>{t("checkCashing.ids")}</SectionTitle>
              <p className={styles.note}>{t("checkCashing.idsRequired")}</p>
              {ids.map((idRow, i) => (
                <div key={i} className={styles.idBlock}>
                  <div className={styles.idBlockHead}>
                    <strong>{t("checkCashing.idNumbered", { n: i + 1 })}</strong>
                    {ids.length > 1 && (
                      <Button
                        type="button" tone="ghost" size="sm"
                        onClick={() => setIds((all) => all.filter((_, j) => j !== i))}
                      >
                        {t("checkCashing.removeId")}
                      </Button>
                    )}
                  </div>
                  <IdFields
                    value={idRow}
                    onChange={(v) => setIds((all) => all.map((x, j) => (j === i ? v : x)))}
                  />
                </div>
              ))}
              {ids.length < 10 && (
                <Button
                  type="button" tone="secondary" size="sm"
                  onClick={() => setIds((all) => [...all, { ...EMPTY_ID }])}
                >
                  {t("checkCashing.addAnotherId")}
                </Button>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle>{t("checkCashing.statusAndFee")}</SectionTitle>
            {canManage ? (
              <PartyRulesFields
                rules={rules}
                onChange={setRules}
                feeHint={t("checkCashing.customerFeeHint")}
              />
            ) : (
              <div className={styles.statusCell}>
                <PartyStatusPill status={rules.status} />
                <span className={styles.muted}>
                  {t("checkCashing.ownFeeIs", { fee: feeLabel(rules.fee_kind, rules.fee_value) })}
                </span>
              </div>
            )}
          </Card>
        </fieldset>
        </DeskPane>

        {error && <Alert tone="error">{error}</Alert>}

        {canEdit && (
          <FormActions guard={guard}>
            <Button type="button" tone="secondary" onClick={() => guard.confirmLeave(backToList)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" busy={busy} disabled={saveDisabled}>
              {isEdit ? t("checkCashing.saveChanges") : t("checkCashing.addCustomer")}
            </Button>
          </FormActions>
        )}
      </DeskForm>
      {customer && (
        <div className="ds-form">
          <CustomerIds customer={customer} canEdit={hasPermission("check_cashing", "update")} />
          <Card>
            <SectionTitle>{t("checkCashing.checksTitle")}</SectionTitle>
            <CheckActivity kind="customers" id={customer.id} other="company" />
          </Card>
        </div>
      )}
      </DeskColumns>
    </DeskPage>
  );
}

/** The customer's IDs on the profile: each saved on its own (add, edit,
 *  remove), so the profile form above never holds a half-typed ID. */
function CustomerIds({
  customer, canEdit,
}: {
  customer: CheckCustomerDetail;
  canEdit: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<{ row: CheckCustomerIdRow | null; body: CheckCustomerIdBody } | null>(null);
  const [removing, setRemoving] = useState<CheckCustomerIdRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onlyOne = customer.ids.length <= 1;

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
  }

  async function saveId() {
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      const body = { ...editing.body, id_number: editing.body.id_number.trim() };
      if (editing.row) await updateCheckCustomerId(customer.id, editing.row.id, body);
      else await addCheckCustomerId(customer.id, body);
      await refresh();
      toast({ message: t("checkCashing.idSaved"), tone: "success" });
      setEditing(null);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function removeId() {
    if (!removing) return;
    setBusy(true); setError(null);
    try {
      await deleteCheckCustomerId(customer.id, removing.id);
      await refresh();
      toast({ message: t("checkCashing.idRemoved"), tone: "success" });
      setRemoving(null);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.removeFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>{t("checkCashing.ids")}</SectionTitle>
      {customer.ids.map((row) => (
        <div key={row.id} className={styles.idRow}>
          <div className={styles.idText}>
            <span className={styles.statusCell}>
              <strong>{idTypeLabel(row.id_type)}</strong>
              {row.expired && <Pill tone="warning">{t("checkCashing.idExpired")}</Pill>}
            </span>
            <span className={styles.mono}>{row.id_number}</span>
            <span className={styles.muted}>
              {[row.issuer, row.expires_on
                ? t("checkCashing.expiresOn", { date: formatDate(row.expires_on) })
                : t("checkCashing.noExpiry")].filter(Boolean).join(" · ")}
            </span>
          </div>
          {canEdit && (
            <div className={styles.idActions}>
              <Button
                type="button" tone="secondary" size="sm"
                onClick={() => {
                  setError(null);
                  setEditing({
                    row,
                    body: {
                      id_type: row.id_type as CheckCustomerIdBody["id_type"],
                      id_number: row.id_number, issuer: row.issuer,
                      expires_on: row.expires_on ?? null,
                    },
                  });
                }}
              >
                {t("checkCashing.editId")}
              </Button>
              {!onlyOne && (
                <Button
                  type="button" tone="ghost" size="sm"
                  onClick={() => { setError(null); setRemoving(row); }}
                >
                  {t("checkCashing.removeId")}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      {canEdit && onlyOne && <p className={styles.note}>{t("checkCashing.lastIdStays")}</p>}
      {canEdit && customer.ids.length < 10 && (
        <Button
          type="button" tone="secondary" size="sm"
          onClick={() => { setError(null); setEditing({ row: null, body: { ...EMPTY_ID } }); }}
        >
          {t("checkCashing.addId")}
        </Button>
      )}

      <Modal
        open={editing != null}
        onClose={() => { if (!busy) setEditing(null); }}
        title={editing?.row ? t("checkCashing.editId") : t("checkCashing.addId")}
        disabled={busy}
        actions={(
          <ModalActions>
            <Button type="button" tone="secondary" onClick={() => setEditing(null)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button" busy={busy}
              disabled={busy || !editing?.body.id_number.trim()}
              onClick={() => { void saveId(); }}
            >
              {t("checkCashing.saveId")}
            </Button>
          </ModalActions>
        )}
      >
        {editing && (
          <IdFields
            value={editing.body}
            onChange={(body) => setEditing({ ...editing, body })}
          />
        )}
        {error && <Alert tone="error">{error}</Alert>}
      </Modal>

      <ConfirmDialog
        open={removing != null}
        title={t("checkCashing.removeIdTitle")}
        message={removing ? t("checkCashing.removeIdMessage", {
          id: `${idTypeLabel(removing.id_type)} ${removing.id_number}`,
        }) : ""}
        confirmLabel={t("checkCashing.removeId")}
        confirmTone="danger"
        busy={busy}
        error={error}
        onConfirm={() => { void removeId(); }}
        onCancel={() => { setRemoving(null); setError(null); }}
      />
    </Card>
  );
}

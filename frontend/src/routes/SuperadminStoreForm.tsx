import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  createSuperadminStore,
  updateSuperadminStore,
  useSuperadminStore,
  type SuperadminStoreCreateBody,
  type SuperadminStoreUpdateBody,
} from "../api/superadmin";
import { ApiError, apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, Button, Card, ErrorState, Field, FormActions,
  Input, Loading, PageHeader, PageShell, PhoneField, SectionTitle, Select,
  space, useToast,
} from "../components/ui";
import { firstError, zEmailOptional, zPhoneOptional } from "../lib/validators";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./SuperadminStoreForm.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { planLabel } from "../api/billing";
import { useT, type MessageKey } from "../i18n";

// /app/superadmin/stores/new + /app/superadmin/stores/:id/edit
//
// Migrated from templates/superadmin_store_form.html. The legacy
// form was create-only — adding an inline edit screen here so the
// SPA covers the full lifecycle (which the legacy system handled
// through the per-action POST endpoints in /superadmin/controls
// and never had a unified edit page for the store identity fields).
//
// Field-level errors mirror the create endpoint's 422/409 shape:
//   { detail: { field, message } }
// The SPA renders inline next to the offending input.

const PLAN_OPTIONS = ["trial", "basic", "pro", "inactive"];

// Which kind of business the store is — drives module defaults
// (module_money_services et al.) through the feature-flag bundles.
const BUSINESS_TYPE_OPTIONS: { value: string; label: MessageKey }[] = [
  { value: "cstore",      label: "switchStore.typeCstore" },
  { value: "gas_station", label: "switchStore.typeGasStation" },
  { value: "grocery",     label: "switchStore.typeGrocery" },
  { value: "msb_hybrid",  label: "switchStore.typeMsbHybrid" },
];

const SPAN_2 = { gridColumn: "1 / -1" } as const;

export default function SuperadminStoreForm() {
  const t = useT();
  const identity = getCurrentIdentity();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id?: string }>();
  const storeId = params.id ? Number(params.id) : null;
  const isEdit = storeId !== null && Number.isFinite(storeId);

  const detailQuery = useSuperadminStore(storeId);

  // Identity fields. Plan defaults to "trial" on create; PATCH
  // hydrates from the loaded row.
  const [name,    setName]    = useState("");
  const [slug,    setSlug]    = useState("");
  const [email,   setEmail]   = useState("");
  const [phone,   setPhone]   = useState("");
  const [address, setAddress] = useState("");
  const [plan,    setPlan]    = useState("trial");
  const [bizType, setBizType] = useState("cstore");
  // Federal tax — stored as a fraction (0.01 = 1%) to match the
  // Store column. Only rendered on edit; create doesn't expose it
  // (the legacy form didn't either; default of 0.01 ships from
  // the Store model definition).
  const [federalTaxRate, setFederalTaxRate] = useState<string>("0.01");

  // Initial admin user — create only. The default name is written
  // in the reader's language: once saved it is the person's own name.
  const [adminName,     setAdminName]     = useState(() => t("saForm.defaultAdmin"));
  const [initialRole,   setInitialRole]   = useState("admin");
  const [adminUsername, setAdminUsername] = useState("admin");
  const [adminPassword, setAdminPassword] = useState("");

  const [busy,        setBusy]        = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Baseline snapshot for the unsaved-changes guard. Captured from the
  // hydrated row on edit, and from the blank defaults at mount on create.
  const [baseline, setBaseline] = useState<string | null>(null);
  const toast = useToast();

  const snapshot = JSON.stringify({
    name, slug, email, phone, address, plan, bizType, federalTaxRate,
    adminName, adminUsername, adminPassword, initialRole,
  });

  // Hydrate the form once the GET resolves on edit.
  useEffect(() => {
    if (!isEdit) return;
    const s = detailQuery.data?.store;
    if (!s) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate local editable store fields from server-fetched store row on edit
    setName(s.name);
    setSlug(s.slug);
    setEmail(s.email);
    setPhone(s.phone);
    setAddress(s.address);
    setPlan(s.plan || "trial");
    setBizType(s.business_type || "msb_hybrid");
    setFederalTaxRate(String(s.federal_tax_rate ?? 0.01));
    // Capture the dirty baseline from the hydrated values directly —
    // building it off `snapshot` here would still see the pre-hydrate
    // (blank) field values, since the setters above haven't applied yet.
    setBaseline(JSON.stringify({
      name: s.name, slug: s.slug, email: s.email, phone: s.phone,
      address: s.address, plan: s.plan || "trial",
      bizType: s.business_type || "msb_hybrid",
      federalTaxRate: String(s.federal_tax_rate ?? 0.01),
      adminName, adminUsername, adminPassword, initialRole,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- admin* are create-only defaults, stable in edit mode; re-running on their change isn't wanted
  }, [detailQuery.data, isEdit]);

  // Create mode: capture the blank baseline once at mount so typing marks dirty.
  useEffect(() => {
    if (isEdit) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed the dirty baseline from the initial blank snapshot once for create mode
    setBaseline(snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capture the initial blank snapshot exactly once for create mode
  }, []);

  const isDirty = baseline !== null && snapshot !== baseline;
  const guard = useUnsavedGuard(isDirty && !busy, {
    message: t("saForm.unsaved"),
  });
  const leaveToStores = () =>
    guard.confirmLeave(() => navigate("/superadmin/stores"));

  if (identity?.role !== "superadmin") {
    return (
      <PageShell maxWidth="44rem">
        <PageHeader title={isEdit ? t("saForm.editTitle") : t("saForm.addTitle")} />
        <ErrorState message={t("sa.scopeRequired")} />
      </PageShell>
    );
  }

  if (isEdit && detailQuery.isLoading) {
    return (
      <PageShell maxWidth="44rem">
        <PageHeader title={t("saForm.editTitle")} />
        <Loading />
      </PageShell>
    );
  }
  if (isEdit && (detailQuery.isError || !detailQuery.data)) {
    const err = detailQuery.error;
    return (
      <PageShell maxWidth="44rem">
        <PageHeader title={t("saForm.editTitle")} />
        <ErrorState
          message={t("saForm.loadFailed", { reason: apiErrorMessage(err, "") }).trimEnd()}
          onRetry={() => { void detailQuery.refetch(); }}
        />
      </PageShell>
    );
  }

  function clearFieldError(key: string) {
    setFieldErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }

  function handleApiError(err: unknown) {
    if (err instanceof ApiError) {
      // Field-level error envelope from FastAPI:
      //   { detail: { field: "slug", message: "..." } }
      const detail = (err.body as { detail?: unknown } | null)?.detail;
      if (
        detail && typeof detail === "object" &&
        "field" in detail && "message" in detail
      ) {
        const d = detail as { field: string; message: string };
        setFieldErrors({ [d.field]: d.message });
        return;
      }
      // Pydantic 422 multi-error envelope: detail is an array of
      // { loc, msg, ... }. Pull the first one out.
      if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0] as { loc?: unknown[]; msg?: string };
        const loc = Array.isArray(first.loc) ? first.loc : [];
        const fieldName = loc.length > 1 ? String(loc[loc.length - 1]) : "";
        const msg = first.msg || err.message;
        if (fieldName) {
          setFieldErrors({ [fieldName]: msg });
          return;
        }
      }
      setServerError(err.message);
    } else {
      setServerError(t("common.networkError"));
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Client-side validation (shared validators lib) — instant inline
    // feedback before the network roundtrip. The backend re-validates
    // the same rules (Pydantic) since it's the real trust boundary.
    const clientErrors: Record<string, string> = {};
    const emailErr = firstError(zEmailOptional, email.trim());
    if (emailErr) clientErrors.email = emailErr;
    const phoneErr = firstError(zPhoneOptional, phone.trim());
    if (phoneErr) clientErrors.phone = phoneErr;
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors);
      setServerError(null);
      return;
    }
    setBusy(true);
    setServerError(null);
    setFieldErrors({});
    try {
      if (isEdit && storeId !== null) {
        const body: SuperadminStoreUpdateBody = {
          name:    name.trim(),
          slug:    slug.trim(),
          email:   email.trim(),
          phone:   phone.trim(),
          address: address.trim(),
          plan,
          business_type: bizType,
        };
        const parsedRate = Number.parseFloat(federalTaxRate);
        if (Number.isFinite(parsedRate)) {
          body.federal_tax_rate = parsedRate;
        }
        await updateSuperadminStore(storeId, body);
        // Refresh the detail + list caches so the next paint shows
        // the canonical normalized values (lowercased slug, etc.).
        queryClient.invalidateQueries({ queryKey: ["superadmin", "store", storeId] });
        queryClient.invalidateQueries({ queryKey: ["superadmin", "stores"] });
        toast({ message: t("saForm.updated"), tone: "success" });
      } else {
        const body: SuperadminStoreCreateBody = {
          name:           name.trim(),
          slug:           slug.trim(),
          email:          email.trim(),
          phone:          phone.trim(),
          address:        address.trim(),
          plan,
          business_type:  bizType,
          admin_username: adminUsername.trim() || "admin",
          admin_name:     adminName.trim() || t("saForm.defaultAdmin"),
          admin_password: adminPassword,
          initial_role:   initialRole,
        };
        await createSuperadminStore(body);
        queryClient.invalidateQueries({ queryKey: ["superadmin", "stores"] });
        toast({ message: t("saForm.created", { name: body.name }), tone: "success" });
        guard.proceed(() => navigate("/superadmin/stores"));
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      setBusy(false);
    }
  }

  const loadedName = detailQuery.data?.store.name;
  const heading = isEdit
    ? (loadedName ? t("saForm.editHeading", { name: loadedName }) : t("saForm.editTitle"))
    : t("saForm.newHeading");
  const cardTitle = isEdit
    ? t("saForm.updateCard")
    : t("saForm.createCard");

  return (
    <PageShell maxWidth="44rem">
      <div className={styles.headerRow}>

        <PageCrumbs
          via={isEdit && storeId
            ? [{ label: name || t("saForm.storeNo", { id: storeId }), to: `/superadmin/stores/${storeId}/drill` }]
            : []}
          current={isEdit ? t("saForm.crumbEdit") : t("saForm.crumbNew")}
        />

        <PageHeader title={heading} />
        <Button type="button" tone="secondary" onClick={leaveToStores}>
          {t("saForm.back")}
        </Button>
      </div>

      <Card padding="1.5rem">
        <SectionTitle>{cardTitle}</SectionTitle>

        <div style={{ marginTop: space.lg, display: "flex", flexDirection: "column", gap: space.md }}>
          {serverError && <Alert tone="error">{serverError}</Alert>}
        </div>

        <form onSubmit={onSubmit} autoComplete="off">
          <div className={styles.sectionTitle}>{t("saForm.businessInfo")}</div>

          <div className={styles.formGrid}>
            <Field label={t("saForm.name")} error={fieldErrors.name}>
              <Input
                type="text" required maxLength={120}
                value={name}
                onChange={(e) => { setName(e.target.value); clearFieldError("name"); }}
                placeholder={t("saForm.namePlaceholder")}
                disabled={busy}
              />
            </Field>

            <Field
              label={t("saForm.slug")}
              error={fieldErrors.slug}
              hint={t("saForm.slugHint")}
            >
              <Input
                type="text" required maxLength={60}
                value={slug}
                onChange={(e) => { setSlug(e.target.value); clearFieldError("slug"); }}
                placeholder={t("saForm.slugPlaceholder")}
                disabled={busy}
              />
            </Field>

            <Field label={t("common.email")} error={fieldErrors.email}>
              <Input
                type="email" maxLength={120}
                value={email}
                onChange={(e) => { setEmail(e.target.value); clearFieldError("email"); }}
                placeholder="owner@business.com"
                disabled={busy}
              />
            </Field>

            <Field
              label={t("common.phone")}
              error={fieldErrors.phone}
              hint={t("saForm.phoneHint")}
            >
              <PhoneField
                value={phone}
                onChange={(v) => { setPhone(v); clearFieldError("phone"); }}
                disabled={busy}
                aria-invalid={Boolean(fieldErrors.phone)}
              />
            </Field>

            <Field label={t("store.address")} error={fieldErrors.address} style={SPAN_2}>
              <Input
                type="text" maxLength={255}
                value={address}
                onChange={(e) => { setAddress(e.target.value); clearFieldError("address"); }}
                placeholder={t("saForm.addressPlaceholder")}
                disabled={busy}
              />
            </Field>

            <Field label={t("saForm.bizType")} error={fieldErrors.business_type}>
              <Select
                value={bizType}
                onChange={(e) => { setBizType(e.target.value); clearFieldError("business_type"); }}
                disabled={busy}
              >
                {BUSINESS_TYPE_OPTIONS.map((b) => (
                  <option key={b.value} value={b.value}>{t(b.label)}</option>
                ))}
              </Select>
            </Field>

            <Field label={t("saStores.colPlan")} error={fieldErrors.plan}>
              <Select
                value={plan}
                onChange={(e) => { setPlan(e.target.value); clearFieldError("plan"); }}
                disabled={busy}
              >
                {PLAN_OPTIONS.map((p) => (
                  <option key={p} value={p}>{planLabel(p)}</option>
                ))}
              </Select>
            </Field>

            {isEdit && (
              <Field
                label={t("saForm.taxRate")}
                error={fieldErrors.federal_tax_rate}
                hint={t("saForm.taxHint")}
              >
                <Input
                  type="number" step="0.0001" min="0" max="1"
                  value={federalTaxRate}
                  onChange={(e) => {
                    setFederalTaxRate(e.target.value);
                    clearFieldError("federal_tax_rate");
                  }}
                  disabled={busy}
                />
              </Field>
            )}
          </div>

          {!isEdit && (
            <>
              <div className={styles.sectionTitle}>{t("saForm.adminLogin")}</div>
              <div className={styles.formGrid}>
                <Field label={t("saForm.adminName")} error={fieldErrors.admin_name}>
                  <Input
                    type="text" maxLength={120}
                    value={adminName}
                    onChange={(e) => {
                      setAdminName(e.target.value);
                      clearFieldError("admin_name");
                    }}
                    placeholder={t("saForm.adminNamePlaceholder")}
                    disabled={busy}
                  />
                </Field>

                <Field label={t("saForm.adminUsername")} error={fieldErrors.admin_username}>
                  <Input
                    type="text" required maxLength={80}
                    value={adminUsername}
                    onChange={(e) => {
                      setAdminUsername(e.target.value);
                      clearFieldError("admin_username");
                    }}
                    disabled={busy}
                  />
                </Field>

                <Field
                  label={t("saForm.initialRole")}
                  hint={initialRole === "owner" ? t("saForm.ownerHint") : t("saForm.adminHint")}
                >
                  <Select
                    value={initialRole}
                    onChange={(e) => setInitialRole(e.target.value)}
                    disabled={busy}
                  >
                    <option value="admin">{t("saForm.roleAdmin")}</option>
                    <option value="owner">{t("saForm.roleOwner")}</option>
                  </Select>
                </Field>

                <Field
                  label={t("saForm.password")}
                  error={fieldErrors.admin_password}
                  style={SPAN_2}
                >
                  <Input
                    type="password" required maxLength={200}
                    value={adminPassword}
                    onChange={(e) => {
                      setAdminPassword(e.target.value);
                      clearFieldError("admin_password");
                    }}
                    placeholder={t("saForm.passwordPlaceholder")}
                    autoComplete="new-password"
                    disabled={busy}
                  />
                </Field>
              </div>
            </>
          )}

          <FormActions guard={guard}>
            <Button type="button" tone="secondary" onClick={leaveToStores}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              busy={busy}
              disabled={busy || !name || !slug || (!isEdit && !adminPassword)}
            >
              {busy
                ? (isEdit ? t("common.saving") : t("saForm.creating"))
                : (isEdit ? t("common.saveChanges") : t("saForm.create"))}
            </Button>
          </FormActions>
        </form>
      </Card>
    </PageShell>
  );
}

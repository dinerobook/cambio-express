import { useMemo, useState, type FormEvent } from "react";

import {
  bulkAddUser, useOwnerLocations,
  type OwnerBulkAddUserBody, type OwnerBulkAddUserResultRow,
} from "../api/owner";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import {
  Alert, AppLink, Button, Card, Checkbox, Empty, ErrorState, Field, FormActions,
  InfoTip, Input, Loading, PageHeader, PageShell, Section, Select,
} from "../components/ui";
import { useDirtyBaseline, useUnsavedGuard } from "../lib/useUnsavedGuard";
import { BulkResultsCard } from "../components/BulkResultsCard";
import { useStoreSelection } from "../lib/useStoreSelection";
import styles from "./OwnerBulkAddUser.module.css";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, tNodes, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// /app/owner/bulk-add-user — owner-side helper to create one
// login at many of their linked stores at once. Useful for a
// regional manager who needs the same credentials across every
// store in the umbrella. Server creates N independent User rows
// (one per store) sharing the same email/phone + password — single-
// row multi-store user is a separate architectural item.

export default function OwnerBulkAddUser() {
  useT(); // re-render on a language switch
  const identity = getCurrentIdentity();
  const { data: locations, isLoading, isError, refetch } =
    useOwnerLocations("month", "");

  const [email, setEmail]         = useState("");
  const [phone, setPhone]         = useState("");
  const [password, setPassword]   = useState("");
  const [fullName, setFullName]   = useState("");
  const [role, setRole]           = useState<OwnerBulkAddUserBody["role"]>("employee");
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState<string | null>(null);
  const [results, setResults]     =
    useState<OwnerBulkAddUserResultRow[] | null>(null);

  const allStoreIds = useMemo(
    () => locations?.rows.map((r) => r.store_id) ?? [],
    [locations],
  );
  const {
    selected: storeIds, isSelected, toggle: toggleStore, toggleAll, allSelected,
  } = useStoreSelection(allStoreIds);

  const { dirty, markSaved } = useDirtyBaseline({ email, phone, password, fullName, role });
  const guard = useUnsavedGuard(dirty && !busy, {
    message: t("bulkAdd.unsaved"),
  });

  if (!identity || (identity.role !== "owner"
                    && identity.role !== "superadmin")) {
    return (
      <PageShell>
        <PageHeader title={navWord("Add user to stores")} />
        <Empty>{t("bulkAdd.ownerOnly")}</Empty>
      </PageShell>
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null); setResults(null); setBusy(true);
    try {
      const out = await bulkAddUser({
        email: email.trim(),
        phone: phone.trim(),
        password,
        full_name: fullName.trim(),
        role,
        store_ids: storeIds,
      });
      setResults(out.results);
      // Wipe the password input so accidental re-submit doesn't
      // reuse it. Username + full name stay so the operator can
      // iterate on a partial-success result.
      setPassword("");
      markSaved();
    } catch (e2) {
      setErr(
        apiErrorMessage(e2, t("bulkAdd.createFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell maxWidth="56rem">

      <PageCrumbs />

      <PageHeader
        title={navWord("Add user to stores")}
        subtitle={t("bulkAdd.subtitle")}
      />

      {isLoading && <Loading />}
      {isError && (
        <ErrorState
          message={t("bulkAdd.storesLoadFailed")}
          onRetry={() => { void refetch(); }}
        />
      )}

      {locations && locations.rows.length === 0 && (
        <Empty>
          {tNodes("bulkAdd.noStores", {
            link: <AppLink to="/owner/connect">{navWord("Connect a store")}</AppLink>,
          })}
        </Empty>
      )}

      {locations && locations.rows.length > 0 && (
        <form onSubmit={onSubmit}>
          <Card>
            <Section>
              <div className={styles.grid}>
                <Field
                  label={t("bulkAdd.email")}
                  hint={t("bulkAdd.emailHint")}
                >
                  <Input
                    type="email" maxLength={255}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                    placeholder="manager@example.com"
                  />
                </Field>
                <Field label={t("bulkAdd.phone")}>
                  <Input
                    type="tel" maxLength={40}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="off"
                    placeholder="(555) 123-4567"
                  />
                </Field>
                <Field
                  label={<>{t("bulkAdd.password")}<InfoTip text={t("bulkAdd.passwordTip")} /></>}
                  hint={t("bulkAdd.passwordHint")}
                >
                  <Input
                    type="password" required minLength={8} maxLength={200}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </Field>
                <Field label={t("bulkAdd.fullName")}>
                  <Input
                    type="text" maxLength={120}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </Field>
                <Field
                  label={t("bulkAdd.role")}
                  hint={role === "accountant" ? t("bulkAdd.accountantHint") : undefined}
                >
                  <Select
                    value={role}
                    onChange={(e) => setRole(e.target.value as OwnerBulkAddUserBody["role"])}
                  >
                    <option value="employee">{t("bulkAdd.employee")}</option>
                    <option value="accountant">{t("bulkAdd.accountant")}</option>
                  </Select>
                </Field>
              </div>
            </Section>

            <Section title={t("bulkAdd.applyTo")}>
              <div className={styles.toolbar}>
                <Button
                  type="button"
                  tone="secondary" size="sm"
                  onClick={toggleAll}
                >
                  {allSelected ? t("bulkAdd.clearAll") : t("bulkAdd.selectAll")}
                </Button>
                <span className={styles.toolbarCount}>
                  {t("bulkAdd.selectedOf", { count: storeIds.length, total: allStoreIds.length })}
                </span>
              </div>
              <ul className={styles.storeList}>
                {locations.rows.map((s) => {
                  const checked = isSelected(s.store_id);
                  return (
                    <li key={s.store_id}>
                      <Checkbox
                        checked={checked}
                        onChange={() => toggleStore(s.store_id)}
                        style={{ alignItems: "center", width: "100%" }}
                      >
                        <span className={styles.storeName}>{s.store_name}</span>{" "}
                        <span className={styles.storeSlug}>{s.store_slug}</span>
                      </Checkbox>
                    </li>
                  );
                })}
              </ul>
            </Section>

            {err && <Alert tone="error">{err}</Alert>}

            <FormActions guard={guard}>
              <Button
                type="submit"
                busy={busy}
                disabled={
                  busy
                  || (!email.trim() && !phone.trim())
                  || password.length < 8
                  || storeIds.length === 0
                }
              >
                {busy
                  ? t("bulkAdd.creating")
                  : tn("bulkAdd.createAt", storeIds.length)}
              </Button>
            </FormActions>
          </Card>
        </form>
      )}

      {results && <BulkResultsCard rows={results} />}
    </PageShell>
  );
}


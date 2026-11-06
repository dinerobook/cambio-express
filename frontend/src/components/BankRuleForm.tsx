import { useState, type FormEvent } from "react";

import {
  createRule,
  dailyBookSlugs,
  MATCH_TYPE_OPTIONS,
  updateRule,
  useBankAccounts,
  useBankCategories,
  type BankCategoryGroup,
  type BankRuleResponse,
} from "../api/bankSync";
import { ApiError } from "../lib/api";
import {
  bodyFromFormValues, EMPTY_RULE_FORM, POST_OFFSET_OPTIONS, postOffsetLabel,
  type BankRuleFormValues,
} from "../lib/bankRules";
import { BankCategoryOptions } from "./BankCategoryOptions";
import {
  Alert, Button, Checkbox, Field, FormActions, Input, MoneyInput, Select,
} from "./ui";
import styles from "./BankRuleForm.module.css";
import { useT } from "../i18n";

// One rule form, three entry points: the rules page (create / edit,
// or "Use" on a template), the "Make a rule" modal on the bank
// transactions page, which opens it prefilled from the row the
// operator is looking at, and the superadmin's rule templates page
// (`template` set). The layout reads as the sentence the rule is —
// IF these conditions THEN this category — the way Monarch's rules
// page does.

/** Template mode: the superadmin writes a rule for every store. No
 *  account (that is per-store), a required name, "Enabled" means
 *  "shown to stores", and saving goes through `submit`. */
export interface BankRuleTemplateMode {
  /** The categories every store has (useTemplateCategories). */
  groups: BankCategoryGroup[] | undefined;
  submit: (values: BankRuleFormValues) => Promise<void>;
}

export function BankRuleForm({
  initial, editingId = null, onSaved, onCancel, template,
}: {
  /** Prefill. Partial so the modal can pass just the suggestion. */
  initial?: Partial<BankRuleFormValues>;
  /** Set when editing an existing rule; null creates one. */
  editingId?: number | null;
  onSaved?: (resp: BankRuleResponse, mode: "create" | "edit") => void;
  onCancel?: () => void;
  template?: BankRuleTemplateMode;
}) {
  // The store's categories and accounts, never fetched in template
  // mode (the superadmin has no store).
  const storeCategories = useBankCategories(!template);
  const accounts = useBankAccounts(!template);
  const groups = template ? template.groups : storeCategories.data?.groups;
  const t = useT();
  const [form, setForm] = useState<BankRuleFormValues>({ ...EMPTY_RULE_FORM, ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const isEdit = editingId != null;
  const booksLine = dailyBookSlugs(groups).has(form.target_kind);

  function patch(p: Partial<BankRuleFormValues>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      if (template) {
        await template.submit(form);
      } else {
        const body = bodyFromFormValues(form);
        const resp = isEdit
          ? await updateRule(editingId, body)
          : await createRule(body);
        onSaved?.(resp, isEdit ? "edit" : "create");
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const detail = (err.body as { detail?: unknown } | null)?.detail;
        if (detail && typeof detail === "object" && "field" in detail) {
          const d = detail as { field: string; message: string };
          setFieldError(d);
        } else {
          setError(err.message);
        }
      } else {
        setError(t("ruleForm.saveFailed"));
      }
    } finally {
      setBusy(false);
    }
  }

  const errFor = (name: string) => fieldError?.field === name ? fieldError.message : undefined;

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      {error && <Alert tone="error">{error}</Alert>}

      <fieldset className={styles.clause}>
        <legend className={styles.legend}>{t("ruleForm.if")}</legend>
        <div className={styles.grid}>
          <Field label={t("ruleForm.description")} error={errFor("desc_match_value")}>
            <div className={styles.descRow}>
              <Select
                aria-label={t("ruleForm.matchTypeAria")}
                value={form.desc_match_type}
                onChange={(e) => patch({ desc_match_type: e.target.value })}
                className={styles.matchType}
              >
                {MATCH_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.label)}</option>
                ))}
              </Select>
              <Input
                value={form.desc_match_value}
                onChange={(e) => patch({ desc_match_value: e.target.value })}
                placeholder={t("ruleForm.matchPh")}
                aria-label={t("ruleForm.matchTextAria")}
              />
            </div>
          </Field>
          <Field label={t("ruleForm.direction")}>
            <Select
              value={form.sign_filter}
              onChange={(e) => patch({ sign_filter: e.target.value })}
            >
              <option value="">{t("ruleForm.any")}</option>
              <option value="credit">{t("ruleForm.moneyIn")}</option>
              <option value="debit">{t("ruleForm.moneyOut")}</option>
            </Select>
          </Field>
          <MoneyInput
            label={t("ruleForm.amountMin")}
            value={form.amount_min}
            onChange={(v) => patch({ amount_min: v })}
            fullWidth
          />
          <MoneyInput
            label={t("ruleForm.amountMax")}
            value={form.amount_max}
            onChange={(v) => patch({ amount_max: v })}
            error={errFor("amount_max_cents")}
            fullWidth
          />
          {!template && (
            <Field label={t("ruleForm.account")} error={errFor("account_filter_id")}>
              <Select
                value={form.account_filter_id}
                onChange={(e) => patch({ account_filter_id: e.target.value })}
              >
                <option value="">{t("ruleForm.anyAccount")}</option>
                {(accounts.data?.rows ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      </fieldset>

      <fieldset className={styles.clause}>
        <legend className={styles.legend}>{t("ruleForm.then")}</legend>
        <div className={styles.grid}>
          <Field label={t("ruleForm.categorizeAs")} error={errFor("target_kind")}>
            <Select
              required
              value={form.target_kind}
              onChange={(e) => patch({ target_kind: e.target.value })}
            >
              <option value="">{t("ruleForm.pickCategory")}</option>
              <BankCategoryOptions groups={groups} />
            </Select>
          </Field>
          {template ? (
            <Field label={t("ruleForm.templateName")} error={errFor("name")}>
              <Input
                required
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder={t("ruleForm.templateNamePh")}
              />
            </Field>
          ) : (
            <Field label={t("ruleForm.ruleName")}>
              <Input
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder={t("ruleForm.ruleNamePh")}
              />
            </Field>
          )}
        </div>
        {booksLine && (
          <>
            <Checkbox
              checked={form.auto_post}
              onChange={(v) => patch({ auto_post: v })}
            >
              {t("ruleForm.alsoBook")}
            </Checkbox>
            {form.auto_post && (
              <Field
                label={t("ruleForm.bookOn")}
                hint={t("ruleForm.bookOnHint")}
              >
                <Select
                  value={String(form.post_date_offset_days)}
                  onChange={(e) =>
                    patch({ post_date_offset_days: Number(e.target.value) })
                  }
                >
                  {POST_OFFSET_OPTIONS.map((days) => (
                    <option key={days} value={days}>{postOffsetLabel(days)}</option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        )}
      </fieldset>

      <div className={styles.options}>
        <Checkbox checked={form.enabled} onChange={(v) => patch({ enabled: v })}>
          {template ? t("ruleForm.showToStores") : t("ruleForm.enabled")}
        </Checkbox>
        {!isEdit && !template && (
          <Checkbox
            checked={form.apply_to_existing}
            onChange={(v) => patch({ apply_to_existing: v })}
          >
            {t("ruleForm.applyExisting")}
          </Checkbox>
        )}
      </div>

      <FormActions>
        {onCancel && (
          <Button type="button" tone="secondary" onClick={onCancel} disabled={busy}>
            {t("ruleForm.cancel")}
          </Button>
        )}
        {template ? (
          <Button type="submit" busy={busy} disabled={busy}>
            {isEdit ? t("ruleForm.saveTemplate") : t("ruleForm.createTemplate")}
          </Button>
        ) : (
          <Button
            type="submit" busy={busy} disabled={busy}
            perm={isEdit ? "bank_sync.update" : "bank_sync.create"}
          >
            {isEdit
              ? (busy ? t("ruleForm.saving") : t("ruleForm.saveRule"))
              : (busy ? t("ruleForm.creating") : t("ruleForm.createRule"))}
          </Button>
        )}
      </FormActions>
    </form>
  );
}

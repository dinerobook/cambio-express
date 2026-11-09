import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  cashCheck, createCheckCompany, createCheckCustomer, EMPTY_ID, REVIEW_LEVEL_TONES,
  sortReviewItems, useCheckCompanies, useCheckCompany, useCheckCustomer,
  useCheckCustomers, useCheckReview, useCompanyCustomers, useCompanyLookup,
  type CheckCustomerIdBody, type CheckReviewItem, type ReviewLevel,
} from "../api/checkCashing";
import { CheckActivity } from "../components/CheckActivity";
import { DeskColumns, DeskPage } from "../components/DeskPage";
import { IdFields, PartyStatusPill } from "../components/CheckCashingFields";
import {
  Alert, AppLink, Button, Card, Checkbox, ConfirmDialog, DateInput, Empty, Field,
  FormActions, Input, Loading, Modal, ModalActions, MoneyInput, PageHeader,
  Pill, SectionTitle, useToast,
} from "../components/ui";
import { navWord } from "../i18n/navWords";
import { useT, type MessageKey } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate } from "../lib/datetime";
import { fmtMoney2 } from "../lib/formatters";
import { hasPermission } from "../lib/permissions";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useUnsavedGuard } from "../lib/useUnsavedGuard";
import styles from "./CheckCashing.module.css";

// Check cashing app → Cash a check (/app/check-cashing), where the app
// opens. Like the counter apps it replaces: the check on top (numbers
// typed, or read by the scanner later), the company that wrote it on
// the left (found by its numbers or name, or added), the customer on
// the right (picked from the company's regulars, searched, or added),
// each with their totals; then the review, the fee and the payout.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Cash a check").

interface CheckForm {
  routing: string;
  account: string;
  number: string;
  date: string;
  amount: number;
}

const EMPTY_CHECK: CheckForm = { routing: "", account: "", number: "", date: "", amount: 0 };

const REVIEW_WORDS: Record<string, MessageKey> = {
  customer_blocked: "checkCashing.rvCustomerBlocked",
  no_id: "checkCashing.rvNoId",
  id_expired: "checkCashing.rvIdExpired",
  customer_trusted: "checkCashing.rvCustomerTrusted",
  cashed_today: "checkCashing.rvCashedToday",
  daily_limit: "checkCashing.rvDailyLimit",
  ctr_due: "checkCashing.rvCtrDue",
  company_blocked: "checkCashing.rvCompanyBlocked",
  company_trusted: "checkCashing.rvCompanyTrusted",
  duplicate: "checkCashing.rvDuplicate",
  first_check: "checkCashing.rvFirstCheck",
  future_dated: "checkCashing.rvFutureDated",
  stale_dated: "checkCashing.rvStaleDated",
};

const LEVEL_WORDS: Record<ReviewLevel, MessageKey> = {
  block: "checkCashing.levelBlock",
  approve: "checkCashing.levelApprove",
  warn: "checkCashing.levelWarn",
  info: "checkCashing.levelInfo",
};

const FEE_SOURCE_WORDS: Record<string, MessageKey> = {
  customer: "checkCashing.feeFromCustomer",
  company: "checkCashing.feeFromCompany",
  store: "checkCashing.feeFromStore",
};

export default function CashCheck() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const identity = getCurrentIdentity();
  const canCash = hasPermission("check_cashing", "create");
  const canApprove = hasPermission("check_cashing_manage", "update");

  const [check, setCheck] = useState<CheckForm>(EMPTY_CHECK);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The company a check's numbers belong to is picked by itself.
  const lookup = useCompanyLookup(check.routing, check.account);
  const found = lookup.data?.company ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a known company's numbers pick it, as a scan would
    if (found) setCompanyId(found.id);
  }, [found]);

  const reviewBody = useMemo(() => ({
    customer_id: customerId, company_id: companyId,
    check_number: check.number.trim(), check_date: check.date || null,
    amount: check.amount,
  }), [customerId, companyId, check.number, check.date, check.amount]);
  const settledBody = useDebouncedValue(reviewBody);
  const review = useCheckReview(
    settledBody, settledBody.customer_id != null || settledBody.company_id != null,
  );
  const reviewCurrent = settledBody === reviewBody && !review.isFetching;
  const items = sortReviewItems(review.data?.items ?? []);
  const suggested = review.data?.fee?.fee ?? 0;
  const feeValue = fee ?? suggested;
  const cash = Math.max(0, check.amount - feeValue);

  const blocks = items.filter((i) => i.level === "block");
  const needsTick = items.filter((i) => i.level === "warn" || i.level === "approve");
  const unticked = needsTick.filter((i) => !ticked.has(i.code));
  const needsManager = items.some((i) => i.level === "approve") && !canApprove;
  const ready = customerId != null && companyId != null && check.amount > 0
    && reviewCurrent && review.data != null;
  const canPay = ready && blocks.length === 0 && unticked.length === 0
    && !needsManager && feeValue <= check.amount;

  const customer = useCheckCustomer(customerId ?? undefined);
  const dirty = companyId != null || customerId != null
    || JSON.stringify(check) !== JSON.stringify(EMPTY_CHECK);
  const guard = useUnsavedGuard(dirty && !busy, { message: t("checkCashing.unsavedCheck") });

  function setC<K extends keyof CheckForm>(key: K, value: CheckForm[K]) {
    setCheck((c) => ({ ...c, [key]: value }));
  }

  function clearAll() {
    setCheck(EMPTY_CHECK);
    setCompanyId(null);
    setCustomerId(null);
    setFee(null);
    setTicked(new Set());
    setError(null);
  }

  async function submit(decision: "cash" | "decline") {
    if (customerId == null || companyId == null) return;
    setBusy(true); setError(null);
    try {
      await cashCheck({
        customer_id: customerId, company_id: companyId,
        check_number: check.number.trim(), check_date: check.date || null,
        amount: check.amount, fee: decision === "cash" ? feeValue : 0,
        acknowledged: needsTick.filter((i) => ticked.has(i.code)).map((i) => i.code),
        decision, reason: decision === "decline" ? declineReason.trim() : "",
        micr: "",
      });
      const name = customer.data?.customer.full_name ?? "";
      toast({
        message: decision === "cash"
          ? t("checkCashing.paid", { amount: fmtMoney2(cash), name })
          : t("checkCashing.declinedSaved"),
        tone: "success",
      });
      setConfirming(false);
      setDeclining(false);
      setDeclineReason("");
      clearAll();
      void queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.cashFailed")));
    } finally {
      setBusy(false);
    }
  }

  const title = navWord("Cash a check");
  if (identity?.store_id == null) {
    return (
      <DeskPage>
        <PageHeader title={title} />
        <Empty>{t("checkCashing.signIn")}</Empty>
      </DeskPage>
    );
  }

  return (
    <DeskPage>
      <PageHeader title={title} subtitle={t("checkCashing.cashSubtitle")} />
      {!canCash && <Alert tone="info">{t("checkCashing.viewOnlyCash")}</Alert>}
      <fieldset disabled={!canCash || busy} className={`${styles.fieldset} ${styles.deskFill}`}>
        <Card>
          <SectionTitle>{t("checkCashing.theCheck")}</SectionTitle>
          <div className={styles.checkStrip}>
            <Field label={t("checkCashing.routing")}>
              <Input
                type="text" inputMode="numeric" maxLength={9}
                className={styles.mono}
                value={check.routing}
                onChange={(e) => setC("routing", e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label={t("checkCashing.account")}>
              <Input
                type="text" inputMode="numeric" maxLength={20}
                className={styles.mono}
                value={check.account}
                onChange={(e) => setC("account", e.target.value.replace(/\D/g, ""))}
              />
            </Field>
            <Field label={t("checkCashing.checkNumber")}>
              <Input
                type="text" maxLength={20}
                value={check.number}
                onChange={(e) => setC("number", e.target.value)}
              />
            </Field>
            <Field label={t("checkCashing.checkDate")}>
              <DateInput value={check.date} onChange={(e) => setC("date", e.target.value)} />
            </Field>
            <MoneyInput
              label={t("checkCashing.checkAmount")}
              value={check.amount}
              onChange={(v) => { setC("amount", v); setFee(null); }}
            />
          </div>
        </Card>

        <DeskColumns>
          <CompanyColumn
            companyId={companyId}
            routing={check.routing}
            account={check.account}
            lookupMissed={lookup.isSuccess && found == null}
            onPick={(id) => { setCompanyId(id); setFee(null); }}
            onPickCustomer={(id) => { setCustomerId(id); setFee(null); }}
          />
          <CustomerColumn
            customerId={customerId}
            onPick={(id) => { setCustomerId(id); setFee(null); }}
          />
          <div className={styles.reviewStack}>
        <Card>
          <SectionTitle>{t("checkCashing.review")}</SectionTitle>
          {!review.data ? (
            review.isFetching ? <Loading /> : <p className={styles.note}>{t("checkCashing.reviewEmpty")}</p>
          ) : items.length === 0 ? (
            <p className={styles.note}>{t("checkCashing.reviewClear")}</p>
          ) : items.map((item) => (
            <ReviewRow
              key={item.code}
              item={item}
              canApprove={canApprove}
              ticked={ticked.has(item.code)}
              onTick={(on) => setTicked((s) => {
                const next = new Set(s);
                if (on) next.add(item.code); else next.delete(item.code);
                return next;
              })}
            />
          ))}
          {canCash && ready && needsManager && (
            <p className={styles.note}>{t("checkCashing.needsManager")}</p>
          )}
        </Card>

        <Card>
          <SectionTitle>{t("checkCashing.payout")}</SectionTitle>
          <div className={styles.money}>
            <MoneyInput
              label={t("checkCashing.fee")}
              hint={review.data?.fee ? t("checkCashing.feeSuggested", {
                fee: fmtMoney2(suggested),
                source: t(FEE_SOURCE_WORDS[review.data.fee.source] ?? "checkCashing.feeFromStore"),
              }) + (review.data.fee.base_applied ? ` ${t("checkCashing.feeBaseApplied")}` : "")
                : undefined}
              value={feeValue}
              onChange={(v) => setFee(v)}
              error={check.amount > 0 && feeValue > check.amount ? t("checkCashing.feeTooHigh") : undefined}
            />
            <div>
              <div className={styles.muted}>{t("checkCashing.cashToPay")}</div>
              <div className={styles.payout} data-testid="cash-to-pay">{fmtMoney2(cash)}</div>
            </div>
          </div>
        </Card>
          </div>
        </DeskColumns>
      </fieldset>

      {error && !confirming && !declining && <Alert tone="error">{error}</Alert>}

      {canCash && (
        <FormActions guard={guard}>
          <Button type="button" tone="secondary" onClick={() => guard.confirmLeave(clearAll)}>
            {t("checkCashing.clear")}
          </Button>
          <Button
            type="button" tone="danger"
            disabled={busy || customerId == null || companyId == null || check.amount <= 0}
            onClick={() => { setError(null); setDeclining(true); }}
          >
            {t("checkCashing.decline")}
          </Button>
          <Button
            type="button" disabled={busy || !canPay}
            onClick={() => { setError(null); setConfirming(true); }}
          >
            {t("checkCashing.cashIt")}
          </Button>
        </FormActions>
      )}

      <ConfirmDialog
        open={confirming}
        title={t("checkCashing.confirmTitle")}
        message={t("checkCashing.confirmMessage", {
          cash: fmtMoney2(cash), name: customer.data?.customer.full_name ?? "",
          amount: fmtMoney2(check.amount), fee: fmtMoney2(feeValue),
        })}
        confirmLabel={t("checkCashing.cashIt")}
        busy={busy}
        error={error}
        onConfirm={() => { void submit("cash"); }}
        onCancel={() => { setConfirming(false); setError(null); }}
      />

      <Modal
        open={declining}
        onClose={() => { if (!busy) setDeclining(false); }}
        title={t("checkCashing.declineTitle")}
        disabled={busy}
        actions={(
          <ModalActions>
            <Button type="button" tone="secondary" disabled={busy} onClick={() => setDeclining(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button" tone="danger" busy={busy}
              disabled={busy || !declineReason.trim()}
              onClick={() => { void submit("decline"); }}
            >
              {t("checkCashing.decline")}
            </Button>
          </ModalActions>
        )}
      >
        <p className={styles.note}>{t("checkCashing.declineHint")}</p>
        <Field label={t("checkCashing.declineReason")}>
          <Input
            type="text" maxLength={255} autoFocus
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
          />
        </Field>
        {error && <Alert tone="error">{error}</Alert>}
      </Modal>
    </DeskPage>
  );
}

function ReviewRow({
  item, canApprove, ticked, onTick,
}: {
  item: CheckReviewItem;
  canApprove: boolean;
  ticked: boolean;
  onTick: (on: boolean) => void;
}) {
  const t = useT();
  const words = item.code === "cashed_today" && item.count === 1
    ? "checkCashing.rvCashedTodayOne" : REVIEW_WORDS[item.code];
  const text = words ? t(words, {
    count: item.count ?? 0,
    amount: fmtMoney2(item.amount ?? 0),
    date: item.day ? formatDate(item.day) : "",
  }) : item.code;
  return (
    <div className={styles.reviewItem}>
      <Pill tone={REVIEW_LEVEL_TONES[item.level]} dot>{t(LEVEL_WORDS[item.level])}</Pill>
      <span className={styles.reviewText}>{text}</span>
      {item.level === "warn" && (
        <Checkbox checked={ticked} onChange={onTick}>{t("checkCashing.tickChecked")}</Checkbox>
      )}
      {item.level === "approve" && (
        <Checkbox checked={ticked} onChange={onTick} disabled={!canApprove}>
          {t("checkCashing.tickApprove")}
        </Checkbox>
      )}
    </div>
  );
}

function PickRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={styles.pickRow} onClick={onClick}>
      {children}
    </button>
  );
}

function CompanyColumn({
  companyId, routing, account, lookupMissed, onPick, onPickCustomer,
}: {
  companyId: number | null;
  routing: string;
  account: string;
  lookupMissed: boolean;
  onPick: (id: number | null) => void;
  onPickCustomer: (id: number) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const settled = useDebouncedValue(q.trim());
  const search = useCheckCompanies({ q: settled, perPage: 8 }, settled.length >= 2);
  const company = useCheckCompany(companyId ?? undefined);
  const regulars = useCompanyCustomers(companyId ?? undefined);

  if (companyId != null) {
    const c = company.data?.company;
    return (
      <Card>
        <SectionTitle>{t("checkCashing.company")}</SectionTitle>
        {!c ? <Loading /> : (
          <>
            <div className={styles.chosenHead}>
              <div className={styles.idText}>
                <h3 className={styles.chosenName}>
                  <AppLink to={`/check-cashing/companies/${c.id}`}>{c.name}</AppLink>
                </h3>
                <span className={styles.statusCell}>
                  <PartyStatusPill status={c.status} />
                  {c.routing_number && (
                    <span className={styles.mono}>
                      {c.routing_number} · ••••{c.account_number.slice(-4)}
                    </span>
                  )}
                </span>
              </div>
              <Button type="button" tone="ghost" size="sm" onClick={() => onPick(null)}>
                {t("checkCashing.change")}
              </Button>
            </div>
            <CheckActivity kind="companies" id={c.id} other="customer" compact />
            <SectionTitle>{t("checkCashing.regulars")}</SectionTitle>
            {regulars.data && regulars.data.rows.length === 0 && (
              <p className={styles.note}>{t("checkCashing.noRegulars")}</p>
            )}
            <div className={styles.pickList}>
              {regulars.data?.rows.map((r) => (
                <PickRow key={r.id} onClick={() => onPickCustomer(r.id)}>
                  <span className={styles.name}>{r.full_name}</span>
                  <span className={styles.muted}>
                    {t(r.checks === 1 ? "checkCashing.regularLineOne" : "checkCashing.regularLine",
                      { n: r.checks, date: formatDate(r.last_day) })}
                  </span>
                </PickRow>
              ))}
            </div>
          </>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle>{t("checkCashing.company")}</SectionTitle>
      {lookupMissed && <Alert tone="info">{t("checkCashing.companyNotFound")}</Alert>}
      <Field label={t("checkCashing.findCompany")}>
        <Input type="search" maxLength={160} value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <div className={styles.pickList}>
        {settled.length >= 2 && search.data?.rows.map((r) => (
          <PickRow key={r.id} onClick={() => onPick(r.id)}>
            <span className={styles.name}>{r.name}</span>
            <PartyStatusPill status={r.status} />
          </PickRow>
        ))}
        {settled.length >= 2 && search.data?.rows.length === 0 && (
          <p className={styles.note}>{t("checkCashing.noMatch")}</p>
        )}
      </div>
      <Button type="button" tone="secondary" size="sm" onClick={() => setAdding(true)}>
        {t("checkCashing.newCompany")}
      </Button>
      <NewCompanyModal
        open={adding}
        routing={routing}
        account={account}
        initialName={q.trim()}
        onClose={() => setAdding(false)}
        onAdded={(id) => { setAdding(false); onPick(id); }}
      />
    </Card>
  );
}

function CustomerColumn({
  customerId, onPick,
}: {
  customerId: number | null;
  onPick: (id: number | null) => void;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const settled = useDebouncedValue(q.trim());
  const search = useCheckCustomers({ q: settled, perPage: 8 }, settled.length >= 2);
  const customer = useCheckCustomer(customerId ?? undefined);

  if (customerId != null) {
    const c = customer.data?.customer;
    return (
      <Card>
        <SectionTitle>{t("checkCashing.customer")}</SectionTitle>
        {!c ? <Loading /> : (
          <>
            <div className={styles.chosenHead}>
              <div className={styles.idText}>
                <h3 className={styles.chosenName}>
                  <AppLink to={`/check-cashing/customers/${c.id}`}>{c.full_name}</AppLink>
                </h3>
                <span className={styles.statusCell}>
                  <PartyStatusPill status={c.status} />
                  {c.phone_number && (
                    <span className={styles.muted}>{c.phone_country} {c.phone_number}</span>
                  )}
                </span>
              </div>
              <Button type="button" tone="ghost" size="sm" onClick={() => onPick(null)}>
                {t("checkCashing.change")}
              </Button>
            </div>
            <div className={styles.pickList}>
              {c.ids.map((i) => (
                <span key={i.id} className={styles.statusCell}>
                  <span className={styles.mono}>{i.id_number}</span>
                  <span className={styles.muted}>
                    {i.expires_on
                      ? t("checkCashing.expiresOn", { date: formatDate(i.expires_on) })
                      : t("checkCashing.noExpiry")}
                  </span>
                  {i.expired && <Pill tone="warning">{t("checkCashing.idExpired")}</Pill>}
                </span>
              ))}
            </div>
            <CheckActivity kind="customers" id={c.id} other="company" compact />
          </>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle>{t("checkCashing.customer")}</SectionTitle>
      <Field label={t("checkCashing.findCustomer")}>
        <Input type="search" maxLength={120} value={q} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <div className={styles.pickList}>
        {settled.length >= 2 && search.data?.rows.map((r) => (
          <PickRow key={r.id} onClick={() => onPick(r.id)}>
            <span className={styles.name}>{r.full_name}</span>
            <span className={styles.statusCell}>
              {r.id_summary && <span className={styles.mono}>{r.id_summary}</span>}
              <PartyStatusPill status={r.status} />
            </span>
          </PickRow>
        ))}
        {settled.length >= 2 && search.data?.rows.length === 0 && (
          <p className={styles.note}>{t("checkCashing.noMatch")}</p>
        )}
      </div>
      <Button type="button" tone="secondary" size="sm" onClick={() => setAdding(true)}>
        {t("checkCashing.newCustomer")}
      </Button>
      <NewCustomerModal
        open={adding}
        initialName={q.trim()}
        onClose={() => setAdding(false)}
        onAdded={(id) => { setAdding(false); onPick(id); }}
      />
    </Card>
  );
}

function NewCompanyModal({
  open, routing, account, initialName, onClose, onAdded,
}: {
  open: boolean;
  routing: string;
  account: string;
  initialName: string;
  onClose: () => void;
  onAdded: (id: number) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start each new company from what was searched
    if (open) { setName(initialName); setPhone(""); setError(null); }
  }, [open, initialName]);

  const numbers = /^\d{9}$/.test(routing) && account.length > 0;

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await createCheckCompany({
        name: name.trim(), phone: phone.trim(), address: "", notes: "",
        status: "normal", status_reason: "",
        routing_number: numbers ? routing : "", account_number: numbers ? account : "",
      });
      void queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      onAdded(res.company.id);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={t("checkCashing.newCompany")}
      disabled={busy}
      actions={(
        <ModalActions>
          <Button type="button" tone="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button" busy={busy} disabled={busy || !name.trim()}
            onClick={() => { void save(); }}
          >
            {t("checkCashing.addCompany")}
          </Button>
        </ModalActions>
      )}
    >
      <div className={styles.fieldGrid}>
        <Field label={t("checkCashing.companyName")}>
          <Input type="text" required maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("checkCashing.phone")}>
          <Input type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <p className={styles.note}>
        {numbers
          ? t("checkCashing.newCompanyNumbers", { routing, account: `••••${account.slice(-4)}` })
          : t("checkCashing.newCompanyNoNumbers")}
      </p>
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

function NewCustomerModal({
  open, initialName, onClose, onAdded,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onAdded: (id: number) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [idDoc, setIdDoc] = useState<CheckCustomerIdBody>({ ...EMPTY_ID });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start each new customer from what was searched
    setName(initialName); setPhone(""); setIdDoc({ ...EMPTY_ID }); setError(null);
  }, [open, initialName]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await createCheckCustomer({
        full_name: name.trim(), phone_country: "+1", phone_number: phone.trim(),
        address: "", notes: "", status: "normal", status_reason: "",
        ids: [{ ...idDoc, id_number: idDoc.id_number.trim() }],
      });
      void queryClient.invalidateQueries({ queryKey: ["check-cashing"] });
      onAdded(res.customer.id);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={t("checkCashing.newCustomer")}
      size="lg"
      disabled={busy}
      actions={(
        <ModalActions>
          <Button type="button" tone="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button" busy={busy}
            disabled={busy || !name.trim() || !idDoc.id_number.trim()}
            onClick={() => { void save(); }}
          >
            {t("checkCashing.addCustomer")}
          </Button>
        </ModalActions>
      )}
    >
      <div className={styles.fieldGrid}>
        <Field label={t("checkCashing.fullName")}>
          <Input type="text" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("checkCashing.phone")}>
          <Input type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
      </div>
      <SectionTitle>{t("checkCashing.idNumbered", { n: 1 })}</SectionTitle>
      <IdFields value={idDoc} onChange={setIdDoc} />
      {error && <Alert tone="error">{error}</Alert>}
    </Modal>
  );
}

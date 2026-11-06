import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  completeStripeConnect,
  disconnectBankAccount,
  refreshBankBalances,
  setBankAccountNickname,
  startStripeConnect,
  useBankAccounts,
  type BankAccountRow,
} from "../api/bankSync";
import { canDo } from "../lib/access";
import { apiErrorMessage } from "../lib/api";
import { fmtMoney2 } from "../lib/formatters";
import {
  Button, Card, ConfirmDialog, ErrorState,
  Loading, PageHeader, PageShell, SectionTitle, space, useToast,
} from "../components/ui";
import styles from "./Bank.module.css";
import { formatDateTime } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, tn, useT } from "../i18n";
import { navWord } from "../i18n/navWords";

// mirror MAX_BANK_ACCOUNTS_PER_STORE
const MAX_ACCOUNTS = 6;

declare global {
  interface Window {
    Stripe?: (pk: string) => {
      collectFinancialConnectionsAccounts: (opts: {
        clientSecret: string;
      }) => Promise<{ error?: { message?: string } }>;
    };
  }
}

// /app/bank — connected bank accounts grid + recent transactions
// + the Stripe Financial Connections Connect modal flow.
//
// Connect flow (post-cutover, PR #654):
//   1. SPA POSTs /api/v2/bank/connect → server mints an FC
//      session, returns clientSecret + sessionId + publishableKey.
//   2. SPA loads Stripe.js if not already loaded, then calls
//      stripe.collectFinancialConnectionsAccounts({ clientSecret }).
//   3. Once Stripe.js resolves, SPA POSTs sessionId to
//      /api/v2/bank/connect/complete → server fetches the FC
//      session, upserts the linked accounts.
//   4. SPA invalidates the accounts/transactions React-Query
//      caches so the grid refreshes client-side.
//
// All account-level mutations (refresh, disconnect, sync
// transactions) now POST to /api/v2/bank/* and invalidate the
// React-Query cache for a refresh-free UI update.
export default function Bank() {
  const queryClient = useQueryClient();
  const accounts = useBankAccounts();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  useT(); // re-render on a language switch

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["bank", "accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["bank", "transactions"] });
  }

  async function handleConnect() {
    setConnectError(null);
    setBusy("connect");
    try {
      await ensureStripeJs();
      const session = await startStripeConnect();
      const stripe = window.Stripe?.(session.publishableKey);
      if (!stripe) throw new Error(t("bank.stripeLoad"));
      const result = await stripe.collectFinancialConnectionsAccounts({
        clientSecret: session.clientSecret,
      });
      if (result.error) {
        throw new Error(result.error.message || t("bank.connectCanceled"));
      }
      // Persist server-side, then refresh the accounts grid in
      // place (no full page reload).
      const persisted = await completeStripeConnect(session.sessionId);
      invalidate();
      toast({
        message: persisted.accounts_added > 0
          ? tn("bank.linked", persisted.accounts_added)
          : t("bank.alreadyLinked"),
        tone: "success",
      });
    } catch (e) {
      const msg = apiErrorMessage(e, t("bank.connectFailed"), { anyError: true });
      setConnectError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function handleRefresh() {
    setConnectError(null);
    setBusy("refresh");
    try {
      const r = await refreshBankBalances();
      invalidate();
      toast({
        message: r.error
          ? t("bank.refreshedWarn", { count: r.accounts_refreshed, error: r.error })
          : tn("bank.refreshed", r.accounts_refreshed),
        tone: r.error ? "warning" : "success",
      });
    } catch (e) {
      setConnectError(
        apiErrorMessage(e, t("bank.refreshFailed")),
      );
    } finally {
      setBusy(null);
    }
  }



  async function handleSaveNickname(acctId: number, nickname: string) {
    setConnectError(null);
    setBusy(`nickname:${acctId}`);
    try {
      await setBankAccountNickname(acctId, nickname);
      invalidate();
      toast({
        message: nickname.trim()
          ? t("bank.renamed", { name: nickname.trim() })
          : t("bank.nicknameCleared"),
        tone: "success",
      });
    } catch (e) {
      setConnectError(
        apiErrorMessage(e, t("bank.nicknameFailed")),
      );
    } finally {
      setBusy(null);
    }
  }

  // Confirm-dialog state for the destructive disconnect.  The
  // pending object holds both id + label so the dialog can show
  // the right copy + the action handler can use the right id.
  const [pendingDisconnect, setPendingDisconnect] = useState<
    { id: number; label: string } | null
  >(null);

  async function doDisconnect() {
    if (!pendingDisconnect) return;
    const { id: acctId, label } = pendingDisconnect;
    setConnectError(null);
    setBusy(`disconnect:${acctId}`);
    try {
      await disconnectBankAccount(acctId);
      invalidate();
      toast({ message: t("bank.disconnected", { name: label }), tone: "success" });
    } catch (e) {
      setConnectError(
        apiErrorMessage(e, t("bank.disconnectFailed")),
      );
    } finally {
      setBusy(null);
      setPendingDisconnect(null);
    }
  }

  const accountList = accounts.data?.rows ?? [];
  const atCap = accountList.length >= MAX_ACCOUNTS;

  return (
    <PageShell gap="1.25rem">

      <PageCrumbs />

      <PageHeader title={navWord("Bank accounts")} />

      {connectError && <ErrorState message={connectError} />}

      <Card>
        <header className={styles.sectionHeader}>
          <span className={styles.cardTitle}>
            {t("bank.connected")}
            {accountList.length > 0 && (
              <span className={styles.mutedInline}>
                {" "}{t("bank.ofMax", { count: accountList.length, max: MAX_ACCOUNTS })}
              </span>
            )}
          </span>
          {accountList.length > 0 && (
            <div className={styles.headerActions}>
              <Button
                tone="secondary" size="sm" perm="bank_sync.update"
                busy={busy === "refresh"}
                disabled={busy !== null}
                onClick={() => { void handleRefresh(); }}
              >
                {busy === "refresh" ? t("bank.refreshing") : t("bank.refresh")}
              </Button>
              {!atCap && (
                <Button
                  size="sm" perm="bank_sync.update"
                  busy={busy === "connect"}
                  disabled={busy !== null}
                  onClick={() => { void handleConnect(); }}
                >
                  {busy === "connect" ? t("bank.openingStripe") : t("bank.connectAnother")}
                </Button>
              )}
            </div>
          )}
        </header>

        {accounts.isLoading && <Loading />}
        {accounts.isError && (
          <ErrorState
            message={t("bank.loadFailed")}
            onRetry={() => { void accounts.refetch(); }}
          />
        )}

        {!accounts.isLoading && !accounts.isError && accountList.length === 0 && (
          <div className={styles.emptyConnect}>
            <SectionTitle>{t("bank.connectTitle")}</SectionTitle>
            <p className={styles.muted}>{t("bank.connectBody")}</p>
            <Button
              perm="bank_sync.update"
              busy={busy === "connect"}
              disabled={busy !== null}
              onClick={() => { void handleConnect(); }}
              style={{ marginTop: space.lg }}
            >
              {busy === "connect" ? t("bank.openingStripe") : t("bank.connectButton")}
            </Button>
          </div>
        )}

        {accountList.length > 0 && (
          <div className={styles.accountGrid}>
            {accountList.map((a) => (
              <AccountCard
                key={a.id}
                acct={a}
                onDisconnect={() => setPendingDisconnect({ id: a.id, label: a.label })}
                onSaveNickname={(nickname) => handleSaveNickname(a.id, nickname)}
                disconnectBusy={busy === `disconnect:${a.id}`}
                nicknameBusy={busy === `nickname:${a.id}`}
                anyBusy={busy !== null}
              />
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={pendingDisconnect != null}
        title={t("bank.disconnectTitle")}
        message={t("bank.disconnectBody", {
          name: pendingDisconnect?.label ?? t("bank.thisBank"),
        })}
        confirmLabel={t("bank.disconnect")}
        confirmTone="danger"
        busy={busy === `disconnect:${pendingDisconnect?.id}`}
        onConfirm={() => { void doDisconnect(); }}
        onCancel={() => setPendingDisconnect(null)}
      />
    </PageShell>
  );
}

function AccountCard({
  acct, onDisconnect, onSaveNickname,
  disconnectBusy, nicknameBusy, anyBusy,
}: {
  acct: BankAccountRow;
  onDisconnect: () => void;
  onSaveNickname: (nickname: string) => Promise<void>;
  disconnectBusy: boolean;
  nicknameBusy: boolean;
  anyBusy: boolean;
}) {
  const [nickname, setNickname] = useState(acct.nickname || "");
  const t = useT();
  return (
    <div className={styles.accountCard}>
      <div className={styles.mutedSmall}>
        {acct.institution_name || t("bank.bank")}
        {acct.category && ` · ${acct.category}`}
      </div>
      <div className={styles.accountLabel}>
        {acct.label}
      </div>
      <div className={styles.balance}>
        {fmtMoney2(acct.last_balance)}
      </div>
      <div className={styles.mutedSmall}>
        {acct.last_balance_as_of
          ? t("bank.asOf", { date: formatDateTime(acct.last_balance_as_of) })
          : t("bank.notRefreshed")}
      </div>
      {canDo("bank_sync.update") && (
        <form
          className={styles.nicknameForm}
          onSubmit={(e) => {
            e.preventDefault();
            void onSaveNickname(nickname);
          }}
        >
          <input
            type="text"
            name="nickname"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t("bank.nicknamePh")}
            aria-label={t("bank.nicknameAria", { name: acct.label })}
            maxLength={60}
            className={styles.nicknameInput}
            disabled={anyBusy}
          />
          <Button
            type="submit" tone="secondary" size="sm"
            busy={nicknameBusy}
            disabled={anyBusy || nickname === (acct.nickname || "")}
          >
            {nicknameBusy ? t("common.saving") : t("bank.save")}
          </Button>
        </form>
      )}
      <div className={styles.disconnectForm}>
        <Button
          tone="danger" size="sm" perm="bank_sync.update"
          busy={disconnectBusy}
          disabled={anyBusy}
          onClick={onDisconnect}
        >
          {disconnectBusy ? t("bank.disconnecting") : t("bank.disconnect")}
        </Button>
      </div>
    </div>
  );
}

let _stripeLoadPromise: Promise<void> | null = null;
function ensureStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  if (_stripeLoadPromise) return _stripeLoadPromise;
  _stripeLoadPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(t("bank.stripeLoad")));
    document.head.appendChild(s);
  });
  return _stripeLoadPromise;
}

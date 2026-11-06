import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  PACK_STATUS_TONES, activateLotteryPack, createLotteryGame, receiveLotteryPack,
  recordLotteryCount, returnLotteryPack, settleLotteryPack,
  updateLotteryGame, useLotteryDay, useLotteryGames, useLotteryPacks,
  type LotteryDayRow, type LotteryGame, type LotteryPack,
} from "../api/lottery";
import { apiErrorMessage } from "../lib/api";
import { useApiErrorToast } from "../lib/useApiErrorToast";
import { fmtMoney2 } from "../lib/formatters";
import {
  Alert, Button, Card, ConfirmDialog, DateInput, EmptyState,
  ErrorState,
  Field, InfoTip, Input, KpiCard, KpiGrid, Loading, Modal, MoneyInput, PageHeader,
  PageShell, Pill, RowActions, Section, Select, TabsBar, TabsButton,
  Table, tdStyle, thStyle, useToast,
  ModalActions,
} from "../components/ui";
import styles from "./Lottery.module.css";
import { todayIso } from "../lib/datetime";
import { PageCrumbs } from "../components/PageCrumbs";
import { t, useT, type MessageKey } from "../i18n";
import { navWord } from "../i18n/navWords";

const COUNT_COLUMNS: MessageKey[] = [
  "lot.colBin", "lot.colGame", "lot.colPack", "lot.colPrice", "lot.colPrevious",
  "lot.colClosing", "lot.colSold", "lot.colValue",
];
const PACK_COLUMNS: MessageKey[] = [
  "lot.colGame", "lot.colPack", "common.status", "lot.colBin", "lot.colOpening", "common.actions",
];
const GAME_COLUMNS: MessageKey[] = [
  "lot.colGameNo", "common.name", "lot.colTicketPrice", "lot.colPerPack", "common.status", "common.actions",
];
// A pack status the SPA does not list shows as sent.
const PACK_STATUS_LABELS: Record<string, MessageKey> = {
  received: "lot.status.received",
  active: "lot.status.active",
  settled: "lot.status.settled",
  returned: "lot.status.returned",
};
function packStatusLabel(status: string): string {
  return Object.hasOwn(PACK_STATUS_LABELS, status) ? t(PACK_STATUS_LABELS[status]) : status;
}

export default function Lottery() {
  useT(); // re-render on a language switch
  const [tab, setTab] = useState<"day" | "packs" | "games">("day");
  return (
    <PageShell maxWidth="64rem">
      <PageCrumbs />
      <PageHeader
        title={
          <>
            {navWord("Lottery")}
            <InfoTip text={t("lot.tip")} />
          </>
        }
        subtitle={t("lot.subtitle")}
      />
      <TabsBar>
        <TabsButton active={tab === "day"} onClick={() => setTab("day")}>
          {t("lot.tabDay")}
        </TabsButton>
        <TabsButton active={tab === "packs"} onClick={() => setTab("packs")}>
          {t("lot.tabPacks")}
        </TabsButton>
        <TabsButton active={tab === "games"} onClick={() => setTab("games")}>
          {t("lot.tabGames")}
        </TabsButton>
      </TabsBar>
      {tab === "day" && <DayCloseTab />}
      {tab === "packs" && <PacksTab />}
      {tab === "games" && <GamesTab />}
    </PageShell>
  );
}

// ── Day close ────────────────────────────────────────────────

function DayCloseTab() {
  useT(); // re-render on a language switch
  const [day, setDay] = useState(todayIso());
  const summary = useLotteryDay(day);
  const qc = useQueryClient();
  const toast = useToast();
  const toastApiError = useApiErrorToast();

  async function saveCount(packId: number, closing: number) {
    try {
      await recordLotteryCount(day, {
        pack_id: packId, closing_ticket: closing,
      });
      void qc.invalidateQueries({ queryKey: ["lottery", "day"] });
      toast({ message: t("lot.countSaved"), tone: "success" });
    } catch (err) {
      toastApiError(err, t("lot.countFailed"));
    }
  }

  const data = summary.data;
  return (
    <Section
      title={t("lot.tabDay")}
      actions={
        <DateInput
          aria-label={t("lot.countDate")}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      }
    >
      {summary.isLoading && <Loading />}
      {summary.isError && (
        <ErrorState
          message={t("lot.dayFailed")}
          onRetry={() => { void summary.refetch(); }}
        />
      )}
      {data && data.rows.length === 0 && (
        <EmptyState
          title={t("lot.noActive")}
          body={t("lot.noActiveBody")}
        />
      )}
      {data && data.rows.length > 0 && (
        <>
          <KpiGrid>
            <KpiCard label={t("lot.ticketsSold")} value={String(data.total_sold)} />
            <KpiCard label={t("lot.total")} value={fmtMoney2(data.total_value)} />
            <KpiCard
              label={t("lot.uncounted")}
              value={String(data.uncounted_active_packs)}
              tone={data.uncounted_active_packs > 0 ? "negative" : "positive"}
            />
          </KpiGrid>
          <Card>
            <div style={{ overflowX: "auto" }}>
              <Table>
                <thead>
                  <tr>
                    {COUNT_COLUMNS.map((h) => (
                      <th key={h} style={thStyle}>{t(h)}</th>
                    ))}
                    <th style={thStyle} />
                  </tr>
                </thead>
                <tbody>
                  {/* Keyed by day AND pack: a pack is counted every day,
                      and a pack-only key would keep yesterday's typed
                      closing number in the box after a date switch. */}
                  {data.rows.map((r) => (
                    <CountRow
                      key={`${data.date}:${r.pack_id}`}
                      row={r}
                      onSave={saveCount}
                    />
                  ))}
                </tbody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </Section>
  );
}

function CountRow({
  row, onSave,
}: {
  row: LotteryDayRow;
  onSave: (packId: number, closing: number) => Promise<void>;
}) {
  useT(); // re-render on a language switch
  const [draft, setDraft] = useState(
    row.closing_ticket != null ? String(row.closing_ticket) : "",
  );
  const [busy, setBusy] = useState(false);
  const parsed = Number.parseInt(draft, 10);
  const valid = Number.isInteger(parsed) && parsed >= 0;
  const dirty = valid && parsed !== row.closing_ticket;
  return (
    <tr className={row.counted ? "" : styles.uncountedRow}>
      <td style={tdStyle}>{row.bin_number || "—"}</td>
      <td style={tdStyle}>#{row.game_number} {row.game_name}</td>
      <td style={tdStyle}>{row.pack_number}</td>
      <td style={tdStyle}>{fmtMoney2(row.ticket_price)}</td>
      <td style={tdStyle}>{row.previous_reference}</td>
      <td style={tdStyle}>
        <Input
          type="number" min={0} value={draft}
          aria-label={t("lot.closingFor", { pack: row.pack_number })}
          onChange={(e) => setDraft(e.target.value)}
          className={styles.countInput}
        />
      </td>
      <td style={tdStyle}>{row.counted ? row.sold : "—"}</td>
      <td style={tdStyle}>{row.counted ? fmtMoney2(row.value) : "—"}</td>
      <td style={tdStyle}>
        <Button
          size="sm" busy={busy} disabled={!dirty || busy}
          perm="lottery.create"
          onClick={() => {
            setBusy(true);
            void onSave(row.pack_id, parsed).finally(() => setBusy(false));
          }}
        >
          {t("lot.save")}
        </Button>
      </td>
    </tr>
  );
}

// ── Packs ────────────────────────────────────────────────────

function PacksTab() {
  useT(); // re-render on a language switch
  const packs = useLotteryPacks();
  const games = useLotteryGames();
  const qc = useQueryClient();
  const [receiving, setReceiving] = useState(false);
  const [activating, setActivating] = useState<LotteryPack | null>(null);
  // Settle and Return to state end a pack's life on the books, so
  // both ask first. The failure shows inside the dialog.
  const [pending, setPending] =
    useState<{ kind: "settle" | "return"; pack: LotteryPack } | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingErr, setPendingErr] = useState<string | null>(null);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["lottery"] });
  }

  function ask(kind: "settle" | "return", pack: LotteryPack) {
    setPendingErr(null);
    setPending({ kind, pack });
  }

  async function confirmPending() {
    if (!pending || pendingBusy) return;
    const fn = pending.kind === "settle" ? settleLotteryPack : returnLotteryPack;
    setPendingBusy(true);
    setPendingErr(null);
    try {
      await fn(pending.pack.id, todayIso());
      setPending(null);
      refresh();
    } catch (err) {
      setPendingErr(apiErrorMessage(err, t("lot.packFailed")));
    } finally {
      setPendingBusy(false);
    }
  }

  return (
    <Section
      title={t("lot.tabPacks")}
      actions={
        <Button size="sm" perm="lottery.update" onClick={() => setReceiving(true)}>
          {t("lot.receive")}
        </Button>
      }
    >
      {packs.isLoading && <Loading />}
      {packs.isError && (
        <ErrorState
          message={t("lot.packsFailed")}
          onRetry={() => { void packs.refetch(); }}
        />
      )}
      {packs.data && packs.data.packs.length === 0 && (
        <EmptyState
          title={t("lot.noPacks")}
          body={t("lot.noPacksBody")}
        />
      )}
      {packs.data && packs.data.packs.length > 0 && (
        <Card>
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  {PACK_COLUMNS
                    .map((h) => <th key={h} style={thStyle}>{t(h)}</th>)}
                </tr>
              </thead>
              <tbody>
                {packs.data.packs.map((p) => (
                  <tr key={p.id}>
                    <td style={tdStyle}>#{p.game_number} {p.game_name}</td>
                    <td style={tdStyle}>{p.pack_number}</td>
                    <td style={tdStyle}>
                      <Pill tone={PACK_STATUS_TONES[p.status] ?? "neutral"}>
                        {packStatusLabel(p.status)}
                      </Pill>
                    </td>
                    <td style={tdStyle}>{p.bin_number || "—"}</td>
                    <td style={tdStyle}>{p.opening_ticket}</td>
                    <td style={tdStyle}>
                      <RowActions
                        title={t("lot.packTitle", { pack: p.pack_number })}
                        actions={[
                          {
                            label: t("lot.activate"),
                            perm: "lottery.update",
                            tone: "primary",
                            hidden: p.status !== "received",
                            onClick: () => setActivating(p),
                          },
                          {
                            label: t("lot.settle"),
                            perm: "lottery.update",
                            hidden: p.status !== "active",
                            onClick: () => ask("settle", p),
                          },
                          {
                            label: t("lot.returnToState"),
                            perm: "lottery.update",
                            tone: "warning",
                            hidden: !["received", "active"].includes(p.status),
                            onClick: () => ask("return", p),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <ReceivePackModal
        open={receiving}
        games={games.data?.games ?? []}
        onClose={() => setReceiving(false)}
        onDone={() => { setReceiving(false); refresh(); }}
      />
      <ActivatePackModal
        pack={activating}
        onClose={() => setActivating(null)}
        onDone={() => { setActivating(null); refresh(); }}
      />
      <ConfirmDialog
        open={pending != null}
        title={pending?.kind === "return"
          ? t("lot.returnTitle", { pack: pending.pack.pack_number })
          : t("lot.settleTitle", { pack: pending?.pack.pack_number ?? "" })}
        message={pending?.kind === "return"
          ? t("lot.returnMessage")
          : t("lot.settleMessage")}
        confirmLabel={pending?.kind === "return" ? t("lot.returnToState") : t("lot.settle")}
        confirmTone="danger"
        busy={pendingBusy}
        error={pendingErr}
        onConfirm={() => { void confirmPending(); }}
        onCancel={() => setPending(null)}
      />
    </Section>
  );
}

function ReceivePackModal({
  open, games, onClose, onDone,
}: {
  open: boolean;
  games: LotteryGame[];
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [gameId, setGameId] = useState("");
  const [packNumber, setPackNumber] = useState("");
  const [on, setOn] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await receiveLotteryPack({
        game_id: Number(gameId), pack_number: packNumber.trim(),
        received_on: on,
      });
      setPackNumber("");
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("lot.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("lot.receiveTitle")}>
      <form onSubmit={onSubmit} className={styles.modalForm}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t("lot.colGame")}>
          <Select
            value={gameId} required
            onChange={(e) => setGameId(e.target.value)}
          >
            <option value="" disabled>{t("lot.pickGame")}</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                #{g.game_number} {g.name} ({fmtMoney2(g.ticket_price)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("lot.packNumber")}>
          <Input
            type="text" value={packNumber} required maxLength={40}
            onChange={(e) => setPackNumber(e.target.value)}
          />
        </Field>
        <Field label={t("lot.receivedOn")}>
          <DateInput value={on} onChange={(e) => setOn(e.target.value)} />
        </Field>
        <ModalActions>
          <Button tone="secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy || !gameId}>
            {t("lot.receiveButton")}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

function ActivatePackModal({
  pack, onClose, onDone,
}: {
  pack: LotteryPack | null;
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [bin, setBin] = useState("");
  const [opening, setOpening] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!pack) return;
    setBusy(true);
    setError(null);
    try {
      await activateLotteryPack(pack.id, {
        activated_on: todayIso(),
        opening_ticket: Number.parseInt(opening, 10) || 0,
        bin_number: bin.trim(),
      });
      setBin("");
      setOpening("0");
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("lot.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={pack != null}
      onClose={onClose}
      title={
        <>
          {t("lot.activateTitle", { pack: pack?.pack_number ?? "" })}
          <InfoTip text={t("lot.activateTip")} />
        </>
      }
    >
      <form onSubmit={onSubmit} className={styles.modalForm}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t("lot.bin")}>
          <Input
            type="text" value={bin} maxLength={10} placeholder={t("lot.binPlaceholder")}
            onChange={(e) => setBin(e.target.value)}
          />
        </Field>
        <Field label={t("lot.openingTicket")}>
          <Input
            type="number" min={0} value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </Field>
        <ModalActions>
          <Button tone="secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            {t("lot.activate")}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Games ────────────────────────────────────────────────────

function GamesTab() {
  useT(); // re-render on a language switch
  const [showInactive, setShowInactive] = useState(false);
  const games = useLotteryGames(showInactive);
  const qc = useQueryClient();
  const toastApiError = useApiErrorToast();
  const [adding, setAdding] = useState(false);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["lottery"] });
  }

  async function toggleActive(g: LotteryGame) {
    try {
      await updateLotteryGame(g.id, { is_active: !g.is_active });
      refresh();
    } catch (err) {
      toastApiError(err, t("lot.gameFailed"));
    }
  }

  return (
    <Section
      title={t("lot.tabGames")}
      actions={
        <div className={styles.gamesActions}>
          <Button
            size="sm" tone="secondary"
            onClick={() => setShowInactive((v) => !v)}
          >
            {showInactive ? t("dept.hideInactive") : t("dept.showInactive")}
          </Button>
          <Button size="sm" perm="lottery.update" onClick={() => setAdding(true)}>
            {t("lot.addGame")}
          </Button>
        </div>
      }
    >
      {games.isLoading && <Loading />}
      {games.isError && (
        <ErrorState
          message={t("lot.gamesFailed")}
          onRetry={() => { void games.refetch(); }}
        />
      )}
      {games.data && games.data.games.length === 0 && (
        <EmptyState
          title={t("lot.noGames")}
          body={t("lot.noGamesBody")}
        />
      )}
      {games.data && games.data.games.length > 0 && (
        <Card>
          <div style={{ overflowX: "auto" }}>
            <Table>
              <thead>
                <tr>
                  {GAME_COLUMNS.map((h) => (
                    <th key={h} style={thStyle}>{t(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {games.data.games.map((g) => (
                  <tr key={g.id}>
                    <td style={tdStyle}>{g.game_number}</td>
                    <td style={tdStyle}>{g.name}</td>
                    <td style={tdStyle}>{fmtMoney2(g.ticket_price)}</td>
                    <td style={tdStyle}>{g.tickets_per_pack}</td>
                    <td style={tdStyle}>
                      <Pill tone={g.is_active ? "accent" : "neutral"}>
                        {g.is_active ? t("dept.active") : t("dept.inactive")}
                      </Pill>
                    </td>
                    <td style={tdStyle}>
                      <RowActions
                        title={t("lot.gameTitle", { number: g.game_number })}
                        actions={[{
                          label: g.is_active ? t("dept.deactivate") : t("dept.reactivate"),
                          perm: "lottery.update",
                          tone: g.is_active ? "warning" : "primary",
                          onClick: () => toggleActive(g),
                        }]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <AddGameModal
        open={adding}
        onClose={() => setAdding(false)}
        onDone={() => { setAdding(false); refresh(); }}
      />
    </Section>
  );
}

function AddGameModal({
  open, onClose, onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  useT(); // re-render on a language switch
  const [gameNumber, setGameNumber] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState(0);
  const [perPack, setPerPack] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createLotteryGame({
        game_number: gameNumber.trim(), name: name.trim(),
        ticket_price: price,
        tickets_per_pack: Number.parseInt(perPack, 10) || 0,
      });
      setGameNumber(""); setName(""); setPrice(0); setPerPack("");
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, t("lot.saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("lot.addGameTitle")}>
      <form onSubmit={onSubmit} className={styles.modalForm}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field
          label={
            <>
              {t("lot.stateGame")}
              <InfoTip text={t("lot.stateGameTip")} />
            </>
          }
        >
          <Input
            type="text" value={gameNumber} required maxLength={20}
            onChange={(e) => setGameNumber(e.target.value)}
          />
        </Field>
        <Field label={t("common.name")}>
          <Input
            type="text" value={name} required maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <MoneyInput label={t("lot.colTicketPrice")} value={price} onChange={setPrice} fullWidth />
        <Field label={t("lot.perPack")}>
          <Input
            type="number" min={1} value={perPack} required
            onChange={(e) => setPerPack(e.target.value)}
          />
        </Field>
        <ModalActions>
          <Button tone="secondary" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" busy={busy} disabled={busy}>
            {t("lot.addGameButton")}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import {
  addOwnerStore, favoriteStoreIds, returnToOwnerView, switchStore,
  toggleFavoriteStore, useMyStores,
} from "../api/switchStore";
import { apiErrorMessage } from "../lib/api";
import { getCurrentIdentity } from "../lib/auth";
import { fmtNumber } from "../lib/formatters";
import {
  Alert, Button, EmptyState, ErrorState, Field, Input, Loading, Modal, Pill,
  Select,
  useToast,
} from "./ui";
import styles from "./SwitchStoreModal.module.css";
import { useT } from "../i18n";

// The owner's Switch Store modal (U-2 — single-dashboard
// principle, patterned on the competitor's picker): search by
// name or address, favorites (per-device), active-store radio.
// Picking a store swaps the whole session into that store's
// admin view; "Owner overview" returns to the umbrella surfaces.

export default function SwitchStoreModal({
  open, onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={t("switchStore.title")}>
      {open && <SwitchStoreBody onClose={onClose} />}
    </Modal>
  );
}

function SwitchStoreBody({ onClose }: { onClose: () => void }) {
  const identity = getCurrentIdentity();
  const stores = useMyStores(true);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "favorites">("all");
  const [favs, setFavs] = useState(favoriteStoreIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // U-5a "+" add-store view (competitor parity): a small inline
  // form replaces the list; on create we enter the new store.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("cstore");

  const rows = (stores.data?.stores ?? []).filter((s) => {
    if (tab === "favorites" && !favs.has(s.store_id)) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return s.name.toLowerCase().includes(needle)
      || s.address.toLowerCase().includes(needle);
  });
  const favCount = (stores.data?.stores ?? [])
    .filter((s) => favs.has(s.store_id)).length;

  async function enter(storeId: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await switchStore(storeId);
      qc.clear();  // every cached query belonged to the old scope
      toast({ message: t("switchStore.nowViewing", { name: result.store_name }), tone: "success" });
      onClose();
      navigate("/dashboard");
    } catch (err) {
      setError(
        apiErrorMessage(err, t("switchStore.switchFailed")),
      );
    } finally {
      setBusy(false);
    }
  }

  async function createStore() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const row = await addOwnerStore({ name, business_type: newType });
      await qc.invalidateQueries({ queryKey: ["auth", "my-stores"] });
      toast({ message: t("switchStore.created", { name: row.name }), tone: "success" });
      await enter(row.store_id);
    } catch (err) {
      setError(
        apiErrorMessage(err, t("switchStore.createFailed")),
      );
      setBusy(false);
    }
  }

  async function toOwnerView() {
    setBusy(true);
    setError(null);
    try {
      await returnToOwnerView();
      qc.clear();
      onClose();
      navigate("/owner/dashboard");
    } catch {
      setError(t("switchStore.ownerFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <div className={styles.body}>
        {error && <Alert tone="error">{error}</Alert>}
        <Field label={t("switchStore.storeName")}>
          <Input
            autoFocus
            placeholder={t("switchStore.storeNamePh")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
          />
        </Field>
        <Field
          label={t("switchStore.businessType")}
          hint={t("switchStore.businessTypeHint")}
        >
          <Select
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            disabled={busy}
          >
            <option value="cstore">{t("businessType.cstore")}</option>
            <option value="gas_station">{t("businessType.gasStation")}</option>
            <option value="grocery">{t("businessType.grocery")}</option>
            <option value="msb_hybrid">{t("businessType.msbHybrid")}</option>
          </Select>
        </Field>
        <div className={styles.footer}>
          <Button
            tone="primary" size="sm"
            disabled={busy || !newName.trim()}
            onClick={() => { void createStore(); }}
          >
            {busy ? t("switchStore.creating") : t("switchStore.createEnter")}
          </Button>
          <Button
            tone="secondary" size="sm" disabled={busy}
            onClick={() => { setAdding(false); setError(null); }}
          >
            {t("switchStore.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.body}>
      {error && <Alert tone="error">{error}</Alert>}
      <Input
        type="search"
        placeholder={t("switchStore.searchPh")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className={styles.tabsRow}>
        <Button
          size="sm"
          tone={tab === "all" ? "primary" : "secondary"}
          onClick={() => setTab("all")}
        >
          {t("switchStore.allStores", { count: fmtNumber(stores.data?.stores.length ?? 0) })}
        </Button>
        <Button
          size="sm"
          tone={tab === "favorites" ? "primary" : "secondary"}
          onClick={() => setTab("favorites")}
        >
          {t("switchStore.favorites", { count: fmtNumber(favCount) })}
        </Button>
        <Button
          size="sm" tone="secondary"
          aria-label={t("switchStore.addAria")}
          onClick={() => { setAdding(true); setError(null); }}
        >
          {t("switchStore.add")}
        </Button>
      </div>
      {stores.isLoading && <Loading />}
      {stores.isError && (
        <ErrorState
          message={t("switchStore.loadFailed")}
          onRetry={() => { void stores.refetch(); }}
        />
      )}
      {stores.data && rows.length === 0 && (
        <EmptyState
          title={tab === "favorites" ? t("switchStore.noFavorites") : t("switchStore.noMatch")}
          body={
            tab === "favorites"
              ? t("switchStore.noFavoritesBody")
              : t("switchStore.noMatchBody")
          }
        />
      )}
      <div className={styles.list}>
        {rows.map((s) => (
          <div
            key={s.store_id}
            className={s.is_current
              ? `${styles.row} ${styles.rowCurrent}` : styles.row}
          >
            <button
              type="button"
              className={styles.rowMain}
              disabled={busy || s.is_current}
              onClick={() => { void enter(s.store_id); }}
            >
              <span className={styles.rowName}>
                {s.name}
                {s.is_current && <Pill tone="success">{t("switchStore.current")}</Pill>}
              </span>
              {s.address && (
                <span className={styles.rowAddress}>{s.address}</span>
              )}
            </button>
            <button
              type="button"
              className={favs.has(s.store_id)
                ? `${styles.star} ${styles.starOn}` : styles.star}
              aria-label={favs.has(s.store_id)
                ? t("switchStore.unfavorite", { name: s.name })
                : t("switchStore.favorite", { name: s.name })}
              onClick={() =>
                setFavs(new Set(toggleFavoriteStore(s.store_id)))
              }
            >
              ★
            </button>
            <span
              aria-hidden="true"
              className={s.is_current
                ? `${styles.radio} ${styles.radioOn}` : styles.radio}
            />
          </div>
        ))}
      </div>
      {identity?.owner_id != null && identity.role === "admin" && (
        <div className={styles.footer}>
          <Button
            tone="secondary" size="sm" disabled={busy}
            onClick={() => { void toOwnerView(); }}
          >
            {t("switchStore.ownerOverview")}
          </Button>
        </div>
      )}
    </div>
  );
}

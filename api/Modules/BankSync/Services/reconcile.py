"""Bank transactions matched to daily book entries.

The bank often reports money days after the cashier typed it: a
check deposit typed on Monday posts at the bank on Wednesday, a
written check clears three weeks later. Before this module the bank
feed only knew about entries it had created itself, so a rule (or a
tag on the Bank page) booked the same money a second time.

The contract (BankSync INVARIANTS.md "Matching"):

* **Same money = same amount to the cent, the right direction, a
  date close enough.** Only kinds that can ever reach the bank are
  matched (`MATCH_RULES`); cash that stays in the drawer never is.
  Amounts are never "close enough".
* **Three tiers.** *Sure* (one bank row and one entry fit each other
  and nothing else, or the bank's check number is in the entry's
  note) links by itself. *Suggested* (several candidates, or several
  same-day entries adding up to the bank amount) books nothing and
  waits for a person. *None* books as before.
* **A match moves no money.** It links two records, so it is
  allowed on a locked day — which is exactly when a 10-days-late
  bank row arrives. Anything that would change a locked day's
  numbers is still refused by the callers.
* **"No" is remembered.** A rejected pair (`state="rejected"`) is
  never suggested or auto-matched again; unmatching records one.
* **Dismissed rows are out.** An admin's "already handled" row is
  never matched, booked, suggested or ruled.

Writes stay with the callers' transaction (caller commits). Reads
are batched (`CandidateIndex`) so a page of bank rows costs a fixed
number of queries.
"""
from __future__ import annotations

import itertools
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Sequence

from sqlalchemy import or_
from sqlalchemy.orm import Session

from api.Modules.BankSync.Models import BankDailyMatch, BankTransaction
from api.Modules.BankSync.Services.categorize import bank_date_for
from api.Modules.DailyBook.Models import DailyLineItem
from api.Core.Clock import utc_now


FEATURE_FLAG = "bank_matching"

MATCHED = "matched"
REJECTED = "rejected"


@dataclass(frozen=True)
class MatchRule:
    """How a bank tag finds its daily book entries.

    `before` / `after` bound the bank's date relative to the entry's
    day: the bank may post from `before` days earlier (a deposit
    booked on the evening's close-out that the bank dated that
    morning) to `after` days later.
    """
    line_kind: str
    credit: bool       # True = money into the bank
    before: int
    after: int
    label: str


# bank tag slug → the daily book entries it can be. Owner-approved
# windows (2026-10-21): deposits and bank runs within a week, written
# checks within 90 days (they clear when the payee cashes them).
MATCH_RULES: dict[str, MatchRule] = {
    "check_deposit":  MatchRule("check_deposit", True, 1, 7, "Check deposit"),
    "drop":           MatchRule("drop", True, 1, 7, "Cash drop"),
    # The bank deposit of checks the store held: matched to the
    # "Held checks deposited" entry the Deposit button writes.
    "held_checks_deposited": MatchRule(
        "held_check_deposit", True, 1, 7, "Held checks deposited",
    ),
    "from_bank":      MatchRule("from_bank", False, 1, 7, "Cash from bank"),
    "check_expense":  MatchRule("check_expense", False, 0, 90, "Check expense"),
    "check_purchase": MatchRule("check_purchase", False, 0, 90, "Check purchase"),
    "payroll_check":  MatchRule("payroll_check", False, 0, 90, "Check payroll"),
}

TAG_FOR_LINE_KIND: dict[str, str] = {
    r.line_kind: slug for slug, r in MATCH_RULES.items()
}
MATCHABLE_LINE_KINDS: frozenset[str] = frozenset(TAG_FOR_LINE_KIND)

# Several same-day entries adding up to one bank amount: how many at
# most, and how many entries a day may hold before the search is
# skipped (the combinations grow fast; real days have a handful).
_MAX_SUM_PARTS = 4
_MAX_DAY_ENTRIES = 12

_CHECK_NO = re.compile(r"\b(?:CHECK|CHK|CK)\s*(?:NO\.?|NUM(?:BER)?)?\s*#?\s*(\d{3,})\b", re.I)
_HASH_NO = re.compile(r"#\s*(\d{3,})\b")
_DIGITS = re.compile(r"\d{3,}")


def matching_enabled(db: Session, store_id: int) -> bool:
    """The per-store switch. Declared OFF by default
    (`DEFAULT_FEATURE_FLAGS`); unlike the fail-open rule for
    undeclared flags, a database with no registry row yet (a test
    database, a boot before the seed) reads the declared default —
    off — so nothing changes for a store until it is switched on."""
    from api.Modules.Billing.Models import FeatureFlag, StoreFeatureOverride

    override = (
        db.query(StoreFeatureOverride)
          .filter_by(store_id=store_id, flag_key=FEATURE_FLAG)
          .first()
    )
    if override is not None:
        return bool(override.enabled)
    flag = db.query(FeatureFlag).filter_by(key=FEATURE_FLAG).first()
    return bool(flag.enabled_by_default) if flag is not None else False


def bank_check_number(description: str | None) -> int | None:
    """The check number a bank description carries ("CHECK 1042",
    "CHK #1042"), or None."""
    text = description or ""
    m = _CHECK_NO.search(text) or _HASH_NO.search(text)
    return int(m.group(1)) if m else None


def _note_numbers(note: str | None) -> set[int]:
    return {int(n) for n in _DIGITS.findall(note or "")}


def _is_credit(txn: BankTransaction) -> bool:
    return int(txn.amount_cents or 0) > 0


def _abs_cents(txn: BankTransaction) -> int:
    return abs(int(txn.amount_cents or 0))


def rules_for(txn: BankTransaction, slug: str | None = None) -> list[tuple[str, MatchRule]]:
    """The match rules a bank row can use. A tagged row uses its
    tag's rule (none when the tag is not matchable); an untagged row
    may be any matchable kind going its direction — those are only
    ever SUGGESTED, never matched by themselves."""
    tag = txn.category_slug if slug is None else slug
    if tag:
        rule = MATCH_RULES.get(tag)
        if rule is None or rule.credit != _is_credit(txn):
            return []
        return [(tag, rule)]
    return [(s, r) for s, r in MATCH_RULES.items() if r.credit == _is_credit(txn)]


def _posted_between(lo: date, hi: date) -> tuple[Any, Any]:
    """`posted_at` bounds for whole days lo..hi (posted_at is a
    datetime; comparing it to a bare date misreads on SQLite)."""
    return (
        BankTransaction.posted_at >= datetime.combine(lo, datetime.min.time()),
        BankTransaction.posted_at <= datetime.combine(hi, datetime.max.time()),
    )


def _in_window(rule: MatchRule, bank_day: date, line_day: date) -> bool:
    delta = (bank_day - line_day).days
    return -rule.before <= delta <= rule.after


@dataclass
class Candidate:
    """One possible answer to "which entry is this bank row": a
    single entry, or several same-day entries of one kind adding up
    to the bank amount."""
    lines: list[DailyLineItem]
    tag: str
    by_check_number: bool = False

    @property
    def line_ids(self) -> list[int]:
        return [int(x.id) for x in self.lines]

    @property
    def report_date(self) -> date:
        return self.lines[0].report_date

    @property
    def kind(self) -> str:
        return str(self.lines[0].kind)


def _bank_added_line_ids(db: Session, store_id: int) -> set[int]:
    return {
        int(i) for (i,) in
        db.query(BankTransaction.daily_line_item_id)
          .filter(
              BankTransaction.store_id == store_id,
              BankTransaction.daily_line_item_id.isnot(None),
          )
    }


def _matched_pairs(db: Session, store_id: int) -> list[tuple[int, int]]:
    return [
        (int(t), int(l)) for t, l in
        db.query(BankDailyMatch.bank_transaction_id,
                 BankDailyMatch.daily_line_item_id)
          .filter(BankDailyMatch.store_id == store_id,
                  BankDailyMatch.state == MATCHED)
    ]


class CandidateIndex:
    """Candidate search over one store, batched: a page of bank
    rows (or one row) costs a fixed handful of queries."""

    def __init__(self, db: Session, store_id: int, txns: Sequence[BankTransaction]):
        self.db = db
        self.store_id = store_id
        days = [bank_date_for(t) for t in txns] or [utc_now().date()]
        lo = min(days) - timedelta(days=max(r.after for r in MATCH_RULES.values()))
        hi = max(days) + timedelta(days=max(r.before for r in MATCH_RULES.values()))
        self.lines: list[DailyLineItem] = (
            db.query(DailyLineItem)
              .filter(
                  DailyLineItem.store_id == store_id,
                  DailyLineItem.kind.in_(MATCHABLE_LINE_KINDS),
                  DailyLineItem.report_date >= lo,
                  DailyLineItem.report_date <= hi,
              )
              .order_by(DailyLineItem.report_date, DailyLineItem.id)
              .all()
        )
        self.matched = _matched_pairs(db, store_id)
        self.taken: set[int] = (
            _bank_added_line_ids(db, store_id) | {l for _, l in self.matched}
        )
        ids = [int(t.id) for t in txns if t.id is not None]
        self.rejected: set[tuple[int, int]] = set()
        if ids:
            self.rejected = {
                (int(t), int(l)) for t, l in
                db.query(BankDailyMatch.bank_transaction_id,
                         BankDailyMatch.daily_line_item_id)
                  .filter(BankDailyMatch.bank_transaction_id.in_(ids),
                          BankDailyMatch.state == REJECTED)
            }

    def candidates(
        self, txn: BankTransaction, *, slug: str | None = None,
        include_sums: bool = True,
    ) -> list[Candidate]:
        """Every candidate for `txn`, best first: check-number hits,
        then the closest day."""
        amount = _abs_cents(txn)
        if amount <= 0 or (txn.status or "") == "void":
            return []
        bank_day = bank_date_for(txn)
        check_no = bank_check_number(txn.description)
        out: list[Candidate] = []
        tagged = bool(txn.category_slug if slug is None else slug)
        for tag, rule in rules_for(txn, slug):
            pool = [
                ln for ln in self.lines
                if str(ln.kind) == rule.line_kind
                and int(ln.id) not in self.taken
                and (int(txn.id or 0), int(ln.id)) not in self.rejected
                and _in_window(rule, bank_day, ln.report_date)
            ]
            for ln in pool:
                if int(ln.amount_cents or 0) == amount:
                    out.append(Candidate(
                        [ln], tag,
                        by_check_number=(
                            check_no is not None
                            and check_no in _note_numbers(ln.note)
                        ),
                    ))
            if include_sums and tagged:
                by_day: dict[date, list[DailyLineItem]] = {}
                for ln in pool:
                    if 0 < int(ln.amount_cents or 0) < amount:
                        by_day.setdefault(ln.report_date, []).append(ln)
                for day_lines in by_day.values():
                    if len(day_lines) > _MAX_DAY_ENTRIES:
                        continue
                    for n in range(2, min(_MAX_SUM_PARTS, len(day_lines)) + 1):
                        for combo in itertools.combinations(day_lines, n):
                            if sum(int(x.amount_cents or 0) for x in combo) == amount:
                                out.append(Candidate(list(combo), tag))
        out.sort(key=lambda c: (
            not c.by_check_number, len(c.lines),
            abs((bank_day - c.report_date).days), c.line_ids,
        ))
        return out


def _has_live_booked_line(db: Session, txn: BankTransaction) -> bool:
    if not txn.daily_line_item_id:
        return False
    return db.get(DailyLineItem, int(txn.daily_line_item_id)) is not None


def matched_lines(db: Session, txn: BankTransaction) -> list[DailyLineItem]:
    """The live entries this bank row is matched to."""
    ids = [
        int(i) for (i,) in
        db.query(BankDailyMatch.daily_line_item_id)
          .filter(BankDailyMatch.bank_transaction_id == txn.id,
                  BankDailyMatch.state == MATCHED)
    ]
    if not ids:
        return []
    return (
        db.query(DailyLineItem)
          .filter(DailyLineItem.id.in_(ids))
          .order_by(DailyLineItem.report_date, DailyLineItem.id)
          .all()
    )


def _rivals(
    db: Session, txn: BankTransaction, line: DailyLineItem, tag: str,
) -> int:
    """Other bank rows that could just as well be `line`: same
    amount and direction, inside the window, still unresolved and
    tagged the same (or untagged). One rival makes a match a
    suggestion rather than a sure thing."""
    rule = MATCH_RULES[tag]
    amount = _abs_cents(txn)
    signed = amount if rule.credit else -amount
    lo = line.report_date - timedelta(days=rule.before + 1)
    hi = line.report_date + timedelta(days=rule.after + 1)
    rows = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == txn.store_id,
              BankTransaction.id != txn.id,
              BankTransaction.amount_cents == signed,
              BankTransaction.dismissed_at.is_(None),
              or_(BankTransaction.category_slug == tag,
                  BankTransaction.category_slug == "",
                  BankTransaction.category_slug.is_(None)),
              *_posted_between(lo, hi),
          )
          .all()
    )
    if not rows:
        return 0
    rejected = {
        int(t) for (t,) in
        db.query(BankDailyMatch.bank_transaction_id)
          .filter(BankDailyMatch.daily_line_item_id == line.id,
                  BankDailyMatch.state == REJECTED)
    }
    resolved = {
        int(t) for (t,) in
        db.query(BankDailyMatch.bank_transaction_id)
          .filter(BankDailyMatch.store_id == txn.store_id,
                  BankDailyMatch.state == MATCHED)
    }
    n = 0
    for r in rows:
        if (r.status or "") == "void" or int(r.id) in rejected or int(r.id) in resolved:
            continue
        if _has_live_booked_line(db, r):
            continue
        if not _in_window(rule, bank_date_for(r), line.report_date):
            continue
        n += 1
    return n


def sure_match(
    db: Session, txn: BankTransaction, *, slug: str | None = None,
    index: CandidateIndex | None = None,
) -> tuple[Candidate | None, list[Candidate]]:
    """`(sure, candidates)` for a tagged bank row. `sure` is the one
    candidate safe to link without asking, else None; `candidates`
    is everything that fits (empty = nothing on the books)."""
    tag = txn.category_slug if slug is None else slug
    if not tag or tag not in MATCH_RULES or txn.dismissed_at is not None:
        return None, []
    idx = index or CandidateIndex(db, int(txn.store_id), [txn])
    cands = idx.candidates(txn, slug=tag)
    if not cands:
        return None, []
    by_number = [c for c in cands if c.by_check_number and len(c.lines) == 1]
    if len(by_number) == 1:
        return by_number[0], cands
    if len(cands) == 1 and len(cands[0].lines) == 1:
        only = cands[0]
        if _rivals(db, txn, only.lines[0], tag) == 0:
            return only, cands
    return None, cands


def link(
    db: Session, txn: BankTransaction, lines: Iterable[DailyLineItem], *,
    method: str, user_id: int | None = None,
) -> None:
    """Record `txn` as the bank side of `lines` (replacing a
    rejected row for the same pair). Moves no money. Caller
    commits."""
    for ln in lines:
        row = (
            db.query(BankDailyMatch)
              .filter_by(bank_transaction_id=txn.id,
                         daily_line_item_id=ln.id)
              .first()
        )
        if row is None:
            row = BankDailyMatch(
                store_id=txn.store_id, bank_transaction_id=txn.id,
                daily_line_item_id=ln.id,
            )
            db.add(row)
        row.state = MATCHED
        row.method = method
        row.created_by = user_id
        row.created_at = utc_now()
    db.flush()


def reject(
    db: Session, txn: BankTransaction, line_ids: Iterable[int], *,
    user_id: int | None = None,
) -> None:
    """"No, different": never pair these again. Caller commits."""
    for lid in set(int(i) for i in line_ids):
        row = (
            db.query(BankDailyMatch)
              .filter_by(bank_transaction_id=txn.id, daily_line_item_id=lid)
              .first()
        )
        if row is None:
            row = BankDailyMatch(
                store_id=txn.store_id, bank_transaction_id=txn.id,
                daily_line_item_id=lid,
            )
            db.add(row)
        row.state = REJECTED
        row.method = "confirmed"
        row.created_by = user_id
        row.created_at = utc_now()
    db.flush()


def unmatch(db: Session, txn: BankTransaction, *, user_id: int | None = None) -> list[int]:
    """Undo a match. The pairs become rejected so the next sync does
    not match them straight back. Returns the entry ids. Nothing in
    the daily book changes."""
    rows = (
        db.query(BankDailyMatch)
          .filter_by(bank_transaction_id=txn.id, state=MATCHED)
          .all()
    )
    ids = [int(r.daily_line_item_id) for r in rows]
    reject(db, txn, ids, user_id=user_id)
    return ids


def drop_matches_for_txn(db: Session, txn: BankTransaction) -> None:
    """The bank row was re-tagged or untagged: its old matches were
    for another kind. Rejections stay (still "not that one")."""
    (db.query(BankDailyMatch)
       .filter_by(bank_transaction_id=txn.id, state=MATCHED)
       .delete(synchronize_session=False))
    db.flush()


def drop_matches_for_line(db: Session, line_id: int) -> list[int]:
    """The entry was deleted or its amount changed: it no longer
    says what the bank says. The bank row goes back to "not on the
    books" so it is not forgotten. Returns the affected bank row
    ids."""
    rows = (
        db.query(BankDailyMatch)
          .filter_by(daily_line_item_id=line_id)
          .all()
    )
    ids = [int(r.bank_transaction_id) for r in rows if r.state == MATCHED]
    for r in rows:
        db.delete(r)
    db.flush()
    return ids


def auto_match(db: Session, txn: BankTransaction, *, index: CandidateIndex | None = None) -> str:
    """Link a tagged bank row to its entry when the match is sure.
    Returns "matched", "suggested", "none" or "" (row not eligible:
    untagged, not a matchable kind, dismissed, already booked or
    already matched)."""
    if (
        txn.dismissed_at is not None
        or not txn.category_slug
        or txn.category_slug not in MATCH_RULES
        or _has_live_booked_line(db, txn)
        or matched_lines(db, txn)
    ):
        return ""
    sure, cands = sure_match(db, txn, index=index)
    if sure is not None:
        link(db, txn, sure.lines, method="auto")
        return "matched"
    return "suggested" if cands else "none"


def match_new_line(db: Session, line: DailyLineItem) -> int | None:
    """A cashier just typed (or changed) an entry: if a bank row
    that was waiting is surely this entry, link them. Returns the
    bank row id when linked."""
    tag = TAG_FOR_LINE_KIND.get(str(line.kind))
    if tag is None:
        return None
    rule = MATCH_RULES[tag]
    amount = int(line.amount_cents or 0)
    signed = amount if rule.credit else -amount
    lo = line.report_date - timedelta(days=rule.before + 1)
    hi = line.report_date + timedelta(days=rule.after + 1)
    waiting = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == line.store_id,
              BankTransaction.category_slug == tag,
              BankTransaction.amount_cents == signed,
              BankTransaction.dismissed_at.is_(None),
              *_posted_between(lo, hi),
          )
          .order_by(BankTransaction.posted_at, BankTransaction.id)
          .all()
    )
    for txn in waiting:
        if auto_match(db, txn) == "matched" and any(
            int(x.id) == int(line.id) for x in matched_lines(db, txn)
        ):
            return int(txn.id)
    return None


def reconcile_store(db: Session, store_id: int) -> int:
    """Auto-match every waiting tagged bank row of a store — after a
    sync, or when a person asks. Returns how many were linked."""
    # Only rows still waiting (the review clause: nothing booked,
    # nothing matched, not dismissed) — rows already on the books
    # are the bulk of a store's history and need no work.
    rows = (
        db.query(BankTransaction)
          .filter(
              BankTransaction.store_id == store_id,
              BankTransaction.category_slug.in_(list(MATCH_RULES)),
              *_clauses("review"),
          )
          .order_by(BankTransaction.posted_at, BankTransaction.id)
          .all()
    )
    linked = 0
    for txn in rows:
        if auto_match(db, txn) == "matched":
            linked += 1
    return linked


# ── What the Bank page and the daily book show ──────────────

ADDED = "added"            # the bank feed put it on the daily book
SUGGESTED = "suggested"    # possible entries found: a person decides
NOT_ON_BOOKS = "not_on_books"
DISMISSED = "dismissed"


@dataclass
class BooksState:
    status: str = ""
    lines: list[DailyLineItem] = field(default_factory=list)
    candidates: int = 0


def books_states(
    db: Session, store_id: int, txns: Sequence[BankTransaction],
) -> dict[int, BooksState]:
    """The pill every bank row on a page shows, in a fixed number of
    queries. P&L lines and other tags get no pill: they never touch
    the daily book."""
    from api.Modules.BankSync.Services.categories import is_daily_book_kind

    out: dict[int, BooksState] = {}
    if not txns:
        return out
    ids = [int(t.id) for t in txns]
    booked_ids = [int(t.daily_line_item_id) for t in txns if t.daily_line_item_id]
    live_booked = {
        int(i) for (i,) in
        db.query(DailyLineItem.id).filter(DailyLineItem.id.in_(booked_ids))
    } if booked_ids else set()
    match_rows = (
        db.query(BankDailyMatch.bank_transaction_id,
                 BankDailyMatch.daily_line_item_id)
          .filter(BankDailyMatch.bank_transaction_id.in_(ids),
                  BankDailyMatch.state == MATCHED)
          .all()
    )
    line_ids = {int(l) for _, l in match_rows}
    lines = {
        int(x.id): x for x in
        db.query(DailyLineItem).filter(DailyLineItem.id.in_(line_ids))
    } if line_ids else {}
    by_txn: dict[int, list[DailyLineItem]] = {}
    for t, l in match_rows:
        if int(l) in lines:
            by_txn.setdefault(int(t), []).append(lines[int(l)])
    index: CandidateIndex | None = None
    for t in txns:
        tid = int(t.id)
        st = BooksState()
        out[tid] = st
        if t.dismissed_at is not None:
            st.status = DISMISSED
            continue
        if t.daily_line_item_id and int(t.daily_line_item_id) in live_booked:
            st.status = ADDED
            continue
        if by_txn.get(tid):
            st.status = MATCHED
            st.lines = sorted(by_txn[tid], key=lambda x: (x.report_date, x.id))
            continue
        tag = t.category_slug or ""
        if tag and not (tag in MATCH_RULES or is_daily_book_kind(tag)):
            continue
        if (t.status or "") == "void":
            continue
        if index is None:
            index = CandidateIndex(db, store_id, txns)
        st.candidates = len(index.candidates(t))
        if st.candidates:
            st.status = SUGGESTED
        elif tag:
            st.status = NOT_ON_BOOKS
    return out


def _review_slugs() -> list[str]:
    from api.Modules.DailyBook.Services import BOOK_ONLY_KINDS, LINE_ITEM_KINDS
    kinds = {k for k in LINE_ITEM_KINDS if k not in BOOK_ONLY_KINDS}
    return sorted(kinds | set(MATCH_RULES))


def _clauses(kind: str) -> list[Any]:
    """SQL for a daily-book status, store-agnostic (the caller scopes
    the store). `review` = still needs a person: not dismissed, not
    void, nothing booked or matched, and either untagged or tagged
    with something that belongs on the daily book."""
    from sqlalchemy import exists

    live_booked = exists().where(
        DailyLineItem.id == BankTransaction.daily_line_item_id,
    )
    has_match = exists().where(
        BankDailyMatch.bank_transaction_id == BankTransaction.id,
        BankDailyMatch.state == MATCHED,
    )
    if kind == "dismissed":
        return [BankTransaction.dismissed_at.isnot(None)]
    if kind == "matched":
        return [BankTransaction.dismissed_at.is_(None), has_match]
    if kind == "added":
        return [BankTransaction.dismissed_at.is_(None), live_booked]
    if kind == "review":
        return [
            BankTransaction.dismissed_at.is_(None),
            or_(BankTransaction.status.is_(None), BankTransaction.status != "void"),
            ~live_booked,
            ~has_match,
            or_(BankTransaction.category_slug.is_(None),
                BankTransaction.category_slug == "",
                BankTransaction.category_slug.in_(_review_slugs())),
        ]
    return []


def books_clause(books: str) -> list[Any]:
    """The `?books=` filter of the transactions list."""
    return _clauses(books) if books in ("review", "matched", "dismissed") else []


def books_counts(db: Session, store_id: int) -> dict[str, int]:
    """Store-wide counts for the Bank page's summary line."""
    out: dict[str, int] = {}
    for kind in ("added", "matched", "review", "dismissed"):
        out[kind] = (
            db.query(BankTransaction.id)
              .filter(BankTransaction.store_id == store_id, *_clauses(kind))
              .count()
        )
    return out


def line_bank_marks(
    db: Session, store_id: int, line_ids: Sequence[int],
) -> dict[int, tuple[str, date | None]]:
    """entry id → ("added" | "matched", the bank's date) for the
    entries of a daily book page the bank has confirmed."""
    ids = [int(i) for i in line_ids]
    if not ids:
        return {}
    out: dict[int, tuple[str, date | None]] = {}
    for t in (
        db.query(BankTransaction)
          .filter(BankTransaction.store_id == store_id,
                  BankTransaction.daily_line_item_id.in_(ids))
    ):
        out[int(t.daily_line_item_id)] = (ADDED, bank_date_for(t))
    for lid, t in (
        db.query(BankDailyMatch.daily_line_item_id, BankTransaction)
          .join(BankTransaction,
                BankTransaction.id == BankDailyMatch.bank_transaction_id)
          .filter(BankDailyMatch.store_id == store_id,
                  BankDailyMatch.daily_line_item_id.in_(ids),
                  BankDailyMatch.state == MATCHED)
    ):
        out.setdefault(int(lid), (MATCHED, bank_date_for(t)))
    return out


# ── Entries that are in twice (typed AND added by the bank) ─

@dataclass
class PossibleDouble:
    txn: BankTransaction
    bank_line: DailyLineItem
    typed_line: DailyLineItem


def possible_doubles(db: Session, store_id: int) -> list[PossibleDouble]:
    """Bank rows that booked an entry while a typed entry of the same
    kind and amount sits inside the window: probably the same money
    twice. Listed for a person to fix; nothing is deleted here."""
    booked = (
        db.query(BankTransaction, DailyLineItem)
          .join(DailyLineItem, DailyLineItem.id == BankTransaction.daily_line_item_id)
          .filter(
              BankTransaction.store_id == store_id,
              DailyLineItem.kind.in_(MATCHABLE_LINE_KINDS),
          )
          .order_by(BankTransaction.posted_at.desc(), BankTransaction.id.desc())
          .all()
    )
    if not booked:
        return []
    taken = _bank_added_line_ids(db, store_id) | {
        l for _, l in _matched_pairs(db, store_id)
    }
    txn_ids = [int(t.id) for t, _ in booked]
    rejected = {
        (int(t), int(l)) for t, l in
        db.query(BankDailyMatch.bank_transaction_id,
                 BankDailyMatch.daily_line_item_id)
          .filter(BankDailyMatch.bank_transaction_id.in_(txn_ids),
                  BankDailyMatch.state == REJECTED)
    }
    out: list[PossibleDouble] = []
    for txn, bline in booked:
        rule = MATCH_RULES[TAG_FOR_LINE_KIND[str(bline.kind)]]
        bank_day = bank_date_for(txn)
        lo = bank_day - timedelta(days=rule.after)
        hi = bank_day + timedelta(days=rule.before)
        typed = (
            db.query(DailyLineItem)
              .filter(
                  DailyLineItem.store_id == store_id,
                  DailyLineItem.kind == bline.kind,
                  DailyLineItem.amount_cents == bline.amount_cents,
                  DailyLineItem.report_date >= lo,
                  DailyLineItem.report_date <= hi,
                  DailyLineItem.id != bline.id,
              )
              .order_by(DailyLineItem.report_date, DailyLineItem.id)
              .all()
        )
        for tl in typed:
            if int(tl.id) in taken or (int(txn.id), int(tl.id)) in rejected:
                continue
            out.append(PossibleDouble(txn, bline, tl))
            break
    return out


def line_label(kind: str) -> str:
    tag = TAG_FOR_LINE_KIND.get(kind)
    if tag:
        return MATCH_RULES[tag].label
    from api.Modules.DailyBook.Services import LINE_ITEM_KINDS
    entry = LINE_ITEM_KINDS.get(kind)
    return entry[1].capitalize() if entry else kind


__all__ = [
    "ADDED", "BooksState", "Candidate", "CandidateIndex", "DISMISSED",
    "FEATURE_FLAG", "MATCHED", "MATCH_RULES", "MATCHABLE_LINE_KINDS",
    "MatchRule", "NOT_ON_BOOKS", "PossibleDouble", "REJECTED", "SUGGESTED",
    "TAG_FOR_LINE_KIND", "auto_match", "bank_check_number", "books_clause",
    "books_counts", "books_states",
    "drop_matches_for_line", "drop_matches_for_txn", "line_bank_marks",
    "line_label", "link", "match_new_line", "matched_lines",
    "matching_enabled", "possible_doubles", "reconcile_store", "reject",
    "rules_for", "sure_match", "unmatch",
]

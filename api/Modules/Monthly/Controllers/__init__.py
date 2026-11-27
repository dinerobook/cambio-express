"""Monthly module — Controllers (FastAPI router).

Mounts at `/api/v2/monthly/*`. Read-side endpoints:

  GET /monthly/months         → every (year, month) with a saved P&L
                                or a day in either daily book
  GET /monthly/labels         → the store's name for each P&L line
  PUT /monthly/labels         → rename P&L lines
  GET /monthly/{year}/{month} → single-month P&L, live from the daily
                                books + bank feed; 404 only when
                                nothing at all feeds the month
  GET /monthly/{year}/{month}/transactions
                              → every dollar of the month, one row
                                each (flag `pl_transactions`)

JWT-required, scoped to the principal's store. Superadmin (no
store scope) → 403.
"""
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from api.Core.Audit import audit_operator
from api.Core.Database import get_db
from api.Core.Pagination import PaginationParams, pagination_dep, paginate_list
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services import resolve_store_scope
from api.Modules.Auth.Services.principal import has_permission, require_permission
from api.Modules.Monthly.Repositories import list_logged_months
from api.Modules.Monthly.Requests import (
    MonthLogged,
    MonthlyCustomLine,
    MonthlyLabelsResponse,
    MonthlyLabelsUpdateRequest,
    MonthlyLineLabelRow,
    MonthlyResponse,
    MonthlyRow,
    MonthlyUpdateRequest,
    MonthsLoggedResponse,
    PLAcceptRequest,
    PLAcceptResponse,
    PLCategoryCreateRequest,
    PLCategoryListResponse,
    PLCategoryRenameRequest,
    PLCategoryResponse,
    PLCategoryRow,
    PLEntryCategoryRequest,
    PLEntryCategoryResponse,
    PLEntryTarget,
    PLTransactionCounts,
    PLTransactionRow,
    PLTransactionsResponse,
)
from api.Modules.Monthly.Services import (
    MONTHLY_LINE_DEFAULTS,
    MONTHLY_LINE_SECTIONS,
    NAMEABLE_SLOT_FIELDS,
    MonthlySummary,
    UnknownMonthlyLineError,
    custom_line_labels,
    months_with_daily_entries,
    resolved_line_labels,
    set_line_labels,
    summarize_monthly,
    update_monthly,
)
from typing import Any


router = APIRouter()


def _to_row(s: MonthlySummary) -> MonthlyRow:
    r = s.row
    # Build a kwarg dict for every Pydantic field by introspecting
    # MonthlyRow's annotations — keeps the adapter from drifting
    # if a column is added / removed.
    kw: dict[str, Any] = {
        "id": r.id if s.saved else None, "store_id": r.store_id,
        "year": int(r.year), "month": int(r.month),
        "notes": r.notes or "",
        "total_income":   s.total_income,
        "total_expenses": s.total_expenses,
        "net_profit":     s.net_profit,
        "bank_locked":    sorted(s.bank_fed),
        "daily_fed":      s.daily_fed,
        "days_entered":   s.daily.days,
        "money_order_count":   s.daily.money_order_count,
        "money_order_charges": s.daily.money_order_charges,
        "saved":          s.saved,
        "custom_lines":   [
            MonthlyCustomLine(
                id=c.id, slug=c.slug, name=c.name, section=c.section,
                amount=c.amount,
            )
            for c in s.custom
        ],
    }
    for f in MonthlyRow.model_fields:
        if f in kw:
            continue
        # Every line reads its live value (bank feed, daily books,
        # return-check workflow), not only what was last saved.
        kw[f] = s.value(f)
    return MonthlyRow(**kw)


def _month_labels(db: Session, store_id: int) -> dict[str, str]:
    """The store's name for each line, plus each of its own
    categories under its `plc_<id>` slug (Transactions tab rows and
    the statement name them from this one map)."""
    from api.Modules.Monthly.Services.custom_categories import (
        enabled, store_categories,
    )

    labels = resolved_line_labels(db, store_id)
    if enabled(db, store_id):
        labels.update({c.slug: str(c.name) for c in store_categories(db, store_id)})
    return labels


@router.get("/months", response_model=MonthsLoggedResponse)
def months_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthsLoggedResponse:
    require_permission(claims, "monthly", "read")
    store_id = resolve_store_scope(claims)
    # A month with a day in either daily book has a P&L whether or
    # not anyone saved it, so it belongs in the picker too.
    pairs = set(list_logged_months(db, store_id))
    pairs |= months_with_daily_entries(db, store_id)
    return MonthsLoggedResponse(
        months=[
            MonthLogged(year=y, month=m)
            for y, m in sorted(pairs, reverse=True)
        ],
    )


# ── A store's own P&L categories ──────────────────────────────
#
# Declared before `/{year}/{month}`, which would otherwise catch
# `/categories/custom`. Monthly INVARIANTS "Store categories".


def _custom_on(db: Session, sid: int) -> None:
    from api.Modules.Monthly.Services.custom_categories import enabled
    if not enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "pl_transactions_off",
                "message": "Store categories come with the Transactions tab, which is not switched on for this store.",
            },
        )


def _category_row(c: Any, used: dict[int, int]) -> PLCategoryRow:
    return PLCategoryRow(
        id=int(c.id), slug=c.slug, name=str(c.name),
        section="income" if c.section == "income" else "expense",
        archived=c.archived_at is not None, in_use=used.get(int(c.id), 0),
    )


def _category_or_404(db: Session, sid: int, cat_id: int) -> Any:
    from api.Modules.Monthly.Services.custom_categories import find_category
    row = find_category(db, sid, cat_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Category not found")
    return row


def _category_answer(db: Session, sid: int, row: Any) -> PLCategoryResponse:
    from api.Modules.Monthly.Services.custom_categories import in_use
    return PLCategoryResponse(category=_category_row(row, in_use(db, sid)))


def _audit_category(db: Session, claims: dict[str, Any], action: str, row: Any, summary: str) -> None:
    audit_operator(
        db, claims, action=action, target_type="monthly_pl_category",
        target_id=str(row.id), target_label=str(row.name)[:160], summary=summary,
    )


@router.get("/categories/custom", response_model=PLCategoryListResponse)
def custom_categories_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLCategoryListResponse:
    """The store's own P&L categories, archived ones included."""
    from api.Modules.Monthly.Services.custom_categories import (
        enabled, in_use, store_categories,
    )
    require_permission(claims, "monthly", "read")
    sid = resolve_store_scope(claims)
    if not enabled(db, sid):
        return PLCategoryListResponse(enabled=False, rows=[])
    used = in_use(db, sid)
    return PLCategoryListResponse(
        enabled=True,
        rows=[_category_row(c, used) for c in store_categories(db, sid)],
    )


@router.post(
    "/categories/custom", response_model=PLCategoryResponse, status_code=201,
)
def create_custom_category_route(
    body: PLCategoryCreateRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLCategoryResponse:
    """Add a category. As many as the store likes (owner,
    2026-11-27); a name the store already uses is a 422."""
    from api.Modules.Monthly.Services.custom_categories import (
        CategoryError, create_category,
    )
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    _custom_on(db, sid)
    try:
        row = create_category(db, sid, body.name, body.section)
    except CategoryError as exc:
        raise HTTPException(status_code=422, detail={"field": "name", "message": str(exc)})
    _audit_category(db, claims, "monthly_category_create", row, f"section={row.section}")
    db.commit()
    return _category_answer(db, sid, row)


@router.put("/categories/custom/{cat_id}", response_model=PLCategoryResponse)
def rename_custom_category_route(
    cat_id: int = Path(..., ge=1),
    body: PLCategoryRenameRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLCategoryResponse:
    """Rename a category. The rows on it stay on it: the id is what
    they point at."""
    from api.Modules.Monthly.Services.custom_categories import (
        CategoryError, rename_category,
    )
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    _custom_on(db, sid)
    row = _category_or_404(db, sid, cat_id)
    before = str(row.name)
    try:
        rename_category(db, row, body.name)
    except CategoryError as exc:
        raise HTTPException(status_code=422, detail={"field": "name", "message": str(exc)})
    _audit_category(db, claims, "monthly_category_rename", row, f"from={before}"[:500])
    db.commit()
    return _category_answer(db, sid, row)


@router.post("/categories/custom/{cat_id}/archive", response_model=PLCategoryResponse)
def archive_custom_category_route(
    cat_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLCategoryResponse:
    """Take a category off the picker. The rows already on it keep
    counting on it; Restore puts it back."""
    from api.Core.Clock import utc_now
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    _custom_on(db, sid)
    row = _category_or_404(db, sid, cat_id)
    if row.archived_at is None:
        row.archived_at = utc_now()
        _audit_category(db, claims, "monthly_category_archive", row, "archived")
        db.commit()
    return _category_answer(db, sid, row)


@router.post("/categories/custom/{cat_id}/restore", response_model=PLCategoryResponse)
def restore_custom_category_route(
    cat_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLCategoryResponse:
    """Put an archived category back on the picker (422 if an active
    one has taken its name since)."""
    from api.Modules.Monthly.Services.custom_categories import _taken
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    _custom_on(db, sid)
    row = _category_or_404(db, sid, cat_id)
    if row.archived_at is not None:
        if _taken(db, sid, str(row.name), but=int(row.id)):
            raise HTTPException(status_code=422, detail={
                "field": "name",
                "message": "The store already has a category with that name.",
            })
        row.archived_at = None
        _audit_category(db, claims, "monthly_category_restore", row, "restored")
        db.commit()
    return _category_answer(db, sid, row)


@router.get(
    "/{year}/{month}",
    response_model=MonthlyResponse,
)
def monthly_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyResponse:
    require_permission(claims, "monthly", "read")
    store_id = resolve_store_scope(claims)
    summary = summarize_monthly(db, store_id, int(year), int(month))
    if summary is None:
        raise HTTPException(
            status_code=404,
            detail="Nothing recorded for this month yet",
        )
    from api.Modules.Monthly.Services.ledger import pl_transactions_enabled
    return MonthlyResponse(
        report=_to_row(summary),
        labels=_month_labels(db, store_id),
        transactions_enabled=pl_transactions_enabled(db, store_id),
    )


@router.get(
    "/{year}/{month}/transactions",
    response_model=PLTransactionsResponse,
)
def monthly_transactions_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    view: str = Query("all", pattern="^(review|in_pl|not_pl|all)$"),
    line: str = Query("", max_length=60),
    source: str = Query("", pattern="^(|bank|daily|other)$"),
    q: str = Query("", max_length=100),
    pagination: PaginationParams = Depends(pagination_dep),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLTransactionsResponse:
    """The Transactions tab: every dollar of the month, one row each,
    with the line it counts on (Services/ledger.py). Counted rows add
    up to the statement line by line.

    Needs the P&L (`monthly.read`) and the bank rows
    (`bank_sync.read`), and the store's `pl_transactions` switch
    (which needs `bank_matching`): off → 403. `line` narrows to one
    P&L line (the statement's drill-down), `source` to bank rows,
    the daily books or the rest, `q` searches the description (two
    characters or more). `counts` is the whole month, unfiltered."""
    from calendar import monthrange
    from dataclasses import asdict

    from api.Modules.Monthly.Services.entry_categories import target_options
    from api.Modules.Monthly.Services.ledger import (
        build_ledger, pl_transactions_enabled, view_counts,
    )

    require_permission(claims, "monthly", "read")
    require_permission(claims, "bank_sync", "read")
    sid = resolve_store_scope(claims)
    if not pl_transactions_enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "pl_transactions_off",
                "message": "The Transactions tab is not switched on for this store.",
            },
        )
    y, m = int(year), int(month)
    summary = summarize_monthly(db, sid, y, m)
    rows = build_ledger(db, sid, y, m, summary)
    counts = view_counts(rows)
    sources = {
        "bank": {"bank"},
        "daily": {"entry", "day", "service", "money_order_charges"},
        "other": {"returned_checks", "typed"},
    }
    needle = q.strip().lower() if len(q.strip()) >= 2 else ""
    picked = [
        r for r in rows
        if (view == "all" or r.view == view)
        and (not line or r.line == line)
        and (not source or r.source in sources[source])
        and (not needle or needle in r.description.lower())
    ]
    page = paginate_list(picked, pagination)
    return PLTransactionsResponse(
        rows=[
            PLTransactionRow.model_validate({
                **{k: v for k, v in asdict(r).items() if k != "section"},
                "amount": round(r.amount, 2), "bucket": r.bucket,
            })
            for r in page["rows"]
        ],
        total=page["total"], page=page["page"],
        total_pages=page["total_pages"],
        counts=PLTransactionCounts(**counts),
        total_income=summary.total_income if summary else 0.0,
        total_expenses=summary.total_expenses if summary else 0.0,
        net_profit=summary.net_profit if summary else 0.0,
        days_entered=summary.daily.days if summary else 0,
        days_in_month=monthrange(y, m)[1],
        suggested=sum(1 for r in rows if _acceptable(r)),
        entry_targets=[
            PLEntryTarget(slug=slug, label=label)
            for slug, label in target_options(db, sid)
        ],
    )


def _acceptable(r: Any) -> bool:
    """A ledger row "Accept" acts on: a bank row to review with a
    suggestion, or a daily entry still on its own line with one."""
    if not r.suggested_slug:
        return False
    if r.txn_id is not None:
        return bool(r.status == "to_review")
    return r.entry_id is not None and not r.entry_category


@router.post(
    "/{year}/{month}/transactions/accept",
    response_model=PLAcceptResponse,
)
def accept_suggestions_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    body: PLAcceptRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLAcceptResponse:
    """Tag the month's rows to review with their suggestion — one row
    (`txn_ids`) or all of them ("Accept all", owner 2026-11-27: one
    click). The same write path as picking the category by hand
    (`categorize_transaction`), so a daily book category books its
    line and matching links what is already there. A row whose day is
    locked, or that the double-count guard stops, is left to review
    and counted in the answer. One audit row for the batch."""
    from api.Modules.BankSync.Models import BankTransaction
    from api.Modules.BankSync.Services.categorize import (
        DailyBookLockedError, categorize_transaction,
    )
    from api.Modules.Monthly.Services.ledger import (
        build_ledger, daily_twins, pl_transactions_enabled,
    )

    require_permission(claims, "monthly", "read")
    everything = not body.txn_ids and not body.entry_ids
    can_bank = has_permission(claims, "bank_sync", "update")
    can_entries = has_permission(claims, "monthly", "update")
    if body.txn_ids or (everything and not can_entries):
        require_permission(claims, "bank_sync", "update")
    if body.entry_ids:
        require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    if not pl_transactions_enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "pl_transactions_off",
                "message": "The Transactions tab is not switched on for this store.",
            },
        )
    y, m = int(year), int(month)
    wanted, wanted_entries = set(body.txn_ids), set(body.entry_ids)
    ledger = [
        r for r in build_ledger(db, sid, y, m, summarize_monthly(db, sid, y, m))
        if _acceptable(r)
    ]
    picks = [
        (int(r.txn_id), r.suggested_slug) for r in ledger
        if r.txn_id is not None and can_bank
        and (everything or int(r.txn_id) in wanted)
    ]
    moved = _put_entries(db, sid, [
        (int(r.entry_id), r.suggested_slug) for r in ledger
        if r.txn_id is None and r.entry_id is not None and can_entries
        and (everything or int(r.entry_id) in wanted_entries)
    ])
    accepted: list[int] = []
    locked = twins = 0
    for txn_id, slug in picks:
        txn = db.get(BankTransaction, txn_id)
        if txn is None or int(txn.store_id) != sid:
            continue
        if daily_twins(db, txn, slug):
            twins += 1
            continue
        nested = db.begin_nested()
        try:
            categorize_transaction(db, txn, slug)
            nested.commit()
            accepted.append(txn_id)
        except DailyBookLockedError:
            nested.rollback()
            locked += 1
    if accepted or moved:
        audit_operator(
            db, claims,
            action="accept_bank_suggestions",
            target_type="bank_transaction",
            target_id=f"{y}-{m:02d}",
            target_label=f"{y}-{m:02d}",
            summary=(
                f"accepted={len(accepted) + len(moved)} ids="
                + ",".join(str(i) for i in accepted)
                + (" entries=" + ",".join(str(i) for i in moved) if moved else "")
            )[:500],
        )
    db.commit()
    return PLAcceptResponse(
        accepted=len(accepted) + len(moved), locked=locked,
        maybe_in_daily_book=twins,
    )


def _put_entries(db: Session, sid: int, picks: list[tuple[int, str]]) -> list[int]:
    """Put each daily entry on its suggested line; answer the ids
    moved. A locked day does not stop it: the daily book's money is
    untouched."""
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Monthly.Services.entry_categories import (
        is_valid_target, movable_kinds,
    )

    kinds = movable_kinds()
    moved: list[int] = []
    for entry_id, slug in picks:
        item = db.get(DailyLineItem, entry_id)
        if (
            item is None or int(item.store_id) != sid
            or str(item.kind) not in kinds or item.pl_category
            or not is_valid_target(db, sid, slug)
        ):
            continue
        setattr(item, "pl_category", slug)
        moved.append(entry_id)
    return moved


@router.put(
    "/entries/{entry_id}/category",
    response_model=PLEntryCategoryResponse,
)
def entry_category_route(
    entry_id: int = Path(..., ge=1),
    body: PLEntryCategoryRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> PLEntryCategoryResponse:
    """Put a cash / check expense or purchase entry on another expense
    line of the P&L, or back on its own (`slug` ""). Monthly
    INVARIANTS "Daily entries on another line". Moves no money in the
    daily book, so a locked day is fine. Needs `monthly.update` and
    the switch; another store's entry is a 404, a kind that cannot
    move or a line the store cannot pick is a 422. Audited."""
    from api.Modules.DailyBook.Models import DailyLineItem
    from api.Modules.Monthly.Services.entry_categories import (
        is_valid_target, movable_kinds,
    )
    from api.Modules.Monthly.Services.ledger import pl_transactions_enabled

    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    if not pl_transactions_enabled(db, sid):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "pl_transactions_off",
                "message": "The Transactions tab is not switched on for this store.",
            },
        )
    item = db.get(DailyLineItem, entry_id)
    if item is None or int(item.store_id) != sid:
        raise HTTPException(status_code=404, detail="Entry not found.")
    if str(item.kind) not in movable_kinds():
        raise HTTPException(
            status_code=422,
            detail="Only cash and check expenses and purchases can go on another line.",
        )
    slug = body.slug.strip()
    if slug and not is_valid_target(db, sid, slug):
        raise HTTPException(
            status_code=422, detail="Pick one of the store's expense lines.",
        )
    before = str(item.pl_category or "") or "-"
    setattr(item, "pl_category", slug or None)
    audit_operator(
        db, claims,
        action="monthly_entry_category",
        target_type="daily_line_item",
        target_id=str(entry_id),
        target_label=f"{item.report_date.isoformat()} {item.kind}",
        summary=f"{before} -> {slug or '-'}",
    )
    db.commit()
    return PLEntryCategoryResponse(entry_id=entry_id, entry_category=slug)


@router.put(
    "/{year}/{month}",
    response_model=MonthlyResponse,
)
def update_monthly_route(
    year: int = Path(..., ge=2000, le=2100),
    month: int = Path(..., ge=1, le=12),
    body: MonthlyUpdateRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyResponse:
    """Save the editable monthly P&L fields. Server auto-derives
    daily-summed + return-check-net + bank-charge fields and
    overwrites client values for those — same locked-fields
    contract as the legacy /monthly/<year>/<month> POST.

    JWT-required. Principal's store_id MUST match the URL scope
    (cross-store / superadmin → 403). Admin role required (the
    legacy admin-side route is gated by admin_required).

    Auto-creates the row when missing.
    """
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    payload = body.model_dump(exclude_unset=True)
    notes_sent = "notes" in payload
    notes = payload.pop("notes", "")
    fields = {k: v for k, v in payload.items() if v is not None}
    update_monthly(
        db,
        store_id=sid, year=int(year), month=int(month),
        fields=fields, notes=notes,
    )
    # Names the lines the operator sent, never the amounts (the P&L
    # numbers are sensitive) — INVARIANTS.md "Audit invariants".
    touched = sorted(fields) + (["notes"] if notes_sent else [])
    audit_operator(
        db, claims,
        action="update_monthly",
        target_type="monthly",
        target_id=f"{int(year)}-{int(month):02d}",
        target_label=f"{int(year)}-{int(month):02d}",
        summary=("saved " + ", ".join(touched))[:500] if touched else "saved",
    )
    db.commit()
    summary = summarize_monthly(db, sid, int(year), int(month))
    if summary is None:
        raise HTTPException(
            status_code=500, detail="Monthly disappeared after save",
        )
    return MonthlyResponse(
        report=_to_row(summary),
        labels=_month_labels(db, sid),
    )


# ── P&L line names ────────────────────────────────────────────
#
# The P&L ships with the names the first customers used — "Boost
# Mobile", "Money order rent", "EmagineNet / tech" — and a store in
# a different line of business recognises about half of them. These
# two endpoints let it use its own words. What they change is a
# label and nothing else: the column keeps its name, so every bank
# rule, every tagged transaction and every month already closed
# still point at the same place. See `Services/labels.py`.


def _labels_payload(db: Session, store_id: int) -> MonthlyLabelsResponse:
    from api.Modules.BankSync.Services import BANK_PL_CATEGORIES

    custom = custom_line_labels(db, store_id)
    taggable = set(BANK_PL_CATEGORIES.values())
    return MonthlyLabelsResponse(lines=[
        MonthlyLineLabelRow(
            field=field,
            label=custom.get(field) or default,
            default_label=default,
            is_custom=field in custom,
            section=MONTHLY_LINE_SECTIONS[field],
            is_slot=field in NAMEABLE_SLOT_FIELDS,
            bank_taggable=field in taggable,
        )
        for field, default in MONTHLY_LINE_DEFAULTS.items()
    ])


@router.get("/labels", response_model=MonthlyLabelsResponse)
def monthly_labels_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyLabelsResponse:
    """Every renameable P&L line with the store's name for it.

    Read-permission only: an employee who can see the P&L should
    see it under the same names the admin does.
    """
    require_permission(claims, "monthly", "read")
    return _labels_payload(db, resolve_store_scope(claims))


@router.put("/labels", response_model=MonthlyLabelsResponse)
def update_monthly_labels_route(
    body: MonthlyLabelsUpdateRequest = Body(...),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> MonthlyLabelsResponse:
    """Rename P&L lines. Partial — only the lines in the body are
    touched, and an empty value resets one to its shipped default.

    Renaming is a per-store bookkeeping decision, so it takes
    `monthly.update` (the same right as editing the month) and
    writes an audit row naming the lines that moved.
    """
    require_permission(claims, "monthly", "update")
    sid = resolve_store_scope(claims)
    before = custom_line_labels(db, sid)
    try:
        set_line_labels(db, sid, body.labels)
    except UnknownMonthlyLineError as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "field": exc.field,
                "message": f"'{exc.field}' is not a renameable P&L line.",
            },
        ) from exc
    after = custom_line_labels(db, sid)
    changed = sorted(
        f for f in set(before) | set(after)
        if before.get(f) != after.get(f)
    )
    if changed:
        audit_operator(
            db, claims,
            action="monthly_labels_update",
            target_type="monthly_line_label",
            target_id="",
            target_label=", ".join(
                f"{f} → {after.get(f) or MONTHLY_LINE_DEFAULTS[f]}"
                for f in changed
            )[:200],
            summary=f"Renamed {len(changed)} P&L line"
                    f"{'' if len(changed) == 1 else 's'}",
            store_id=sid,
        )
    db.commit()
    return _labels_payload(db, sid)

"""Bank rule templates (BankSync INVARIANTS.md "Rule templates").

The superadmin writes a rule once for every store — "Intermex
commission deposit", "Remote deposit fee" — and a store copies it
into its own rules from the rules page. Two routers:

  GET    /bank/rule-templates                  → the store's list
                                                 (enabled, its names)
  GET    /superadmin/bank-rule-templates       → every template
  GET    /superadmin/bank-rule-templates/categories
  POST   /superadmin/bank-rule-templates
  PUT    /superadmin/bank-rule-templates/{template_id}
  DELETE /superadmin/bank-rule-templates/{template_id}

A template is never applied by itself: using one creates an ordinary
store rule through ``POST /bank/rules``, so editing or deleting a
template never touches a store's rules.
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy.orm import Session

from api.Core.Audit import audit_superadmin
from api.Core.Database import get_db
from api.Modules.Auth.Controllers import get_principal
from api.Modules.Auth.Services import resolve_store_scope, resolve_superadmin_user
from api.Modules.Auth.Services.principal import require_permission
from api.Modules.BankSync.Controllers.rule_validation import (
    validate_rule_conditions,
)
from api.Modules.BankSync.Models import BankRuleTemplate
from api.Modules.BankSync.Repositories import (
    get_rule_template,
    list_rule_templates,
)
from api.Modules.BankSync.Requests import (
    BankCategoriesResponse,
    BankCategoryGroup,
    BankCategoryOption,
    BankRuleTemplateListResponse,
    BankRuleTemplateResponse,
    BankRuleTemplateRow,
    BankRuleTemplateWriteRequest,
)
from api.Modules.BankSync.Services import (
    bank_category_groups,
    is_valid_template_category,
    template_category_groups,
)


router = APIRouter()
superadmin_router = APIRouter()


def _labels(groups: list[tuple[str, list[tuple[str, str]]]]) -> dict[str, str]:
    return {slug: label for _g, options in groups for slug, label in options}


def _row(t: BankRuleTemplate, labels: dict[str, str]) -> BankRuleTemplateRow:
    return BankRuleTemplateRow(
        id=t.id,
        name=t.name,
        enabled=bool(t.enabled),
        desc_match_type=t.desc_match_type or "",
        desc_match_value=t.desc_match_value or "",
        sign_filter=t.sign_filter or "",
        amount_min_cents=t.amount_min_cents,
        amount_max_cents=t.amount_max_cents,
        target_kind=t.target_kind,
        target_label=labels.get(t.target_kind, t.target_kind),
        auto_post=bool(t.auto_post),
        post_date_offset_days=t.post_date_offset_days or 0,
        updated_at=t.updated_at.isoformat() if t.updated_at else "",
    )


# ── store ────────────────────────────────────────────────────


@router.get("/rule-templates", response_model=BankRuleTemplateListResponse)
def list_store_templates_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BankRuleTemplateListResponse:
    """The templates this store can use: enabled ones whose category
    it has, each labelled with the store's own name for it."""
    require_permission(claims, "bank_sync", "read")
    sid = resolve_store_scope(claims)
    labels = _labels(bank_category_groups(db, sid))
    rows = [
        _row(t, labels)
        for t in list_rule_templates(db, enabled_only=True)
        if t.target_kind in labels
    ]
    return BankRuleTemplateListResponse(rows=rows, total=len(rows))


# ── superadmin ───────────────────────────────────────────────


@superadmin_router.get("", response_model=BankRuleTemplateListResponse)
def list_templates_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BankRuleTemplateListResponse:
    resolve_superadmin_user(db, claims)
    labels = _labels(template_category_groups(db))
    rows = [_row(t, labels) for t in list_rule_templates(db)]
    return BankRuleTemplateListResponse(rows=rows, total=len(rows))


@superadmin_router.get("/categories", response_model=BankCategoriesResponse)
def template_categories_route(
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BankCategoriesResponse:
    """The categories a template may target — the ones every store
    has (``template_category_groups``)."""
    resolve_superadmin_user(db, claims)
    return BankCategoriesResponse(groups=[
        BankCategoryGroup(
            label=label,
            posts_to_daily=(idx == 0),
            options=[BankCategoryOption(slug=s, label=lab) for s, lab in options],
        )
        for idx, (label, options) in enumerate(template_category_groups(db))
    ])


def _validate(db: Session, body: BankRuleTemplateWriteRequest) -> None:
    if not body.name.strip():
        raise HTTPException(
            status_code=422,
            detail={"field": "name", "message": "Give the template a name."},
        )
    if not is_valid_template_category(db, body.target_kind):
        raise HTTPException(
            status_code=422,
            detail={
                "field": "target_kind",
                "message": "Pick a category every store has.",
            },
        )
    validate_rule_conditions(body, require_condition=True)


def _write(t: BankRuleTemplate, body: BankRuleTemplateWriteRequest) -> None:
    t.name = body.name.strip()
    t.enabled = body.enabled
    t.desc_match_type = body.desc_match_type
    t.desc_match_value = body.desc_match_value.strip()
    t.sign_filter = body.sign_filter
    t.amount_min_cents = body.amount_min_cents
    t.amount_max_cents = body.amount_max_cents
    t.target_kind = body.target_kind
    t.auto_post = body.auto_post
    t.post_date_offset_days = body.post_date_offset_days


def _find(db: Session, template_id: int) -> BankRuleTemplate:
    t = get_rule_template(db, template_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Rule template not found")
    return t


@superadmin_router.post("", response_model=BankRuleTemplateResponse, status_code=201)
def create_template_route(
    body: BankRuleTemplateWriteRequest,
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BankRuleTemplateResponse:
    user = resolve_superadmin_user(db, claims)
    _validate(db, body)
    t = BankRuleTemplate(created_by=user.id)
    _write(t, body)
    db.add(t)
    db.flush()
    audit_superadmin(
        db, user, action="create_bank_rule_template",
        target_type="bank_rule_template", target_id=str(t.id),
        details=f"{t.name} → {t.target_kind}",
    )
    db.commit()
    return BankRuleTemplateResponse(
        template=_row(t, _labels(template_category_groups(db))),
    )


@superadmin_router.put("/{template_id}", response_model=BankRuleTemplateResponse)
def update_template_route(
    body: BankRuleTemplateWriteRequest,
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> BankRuleTemplateResponse:
    user = resolve_superadmin_user(db, claims)
    t = _find(db, template_id)
    _validate(db, body)
    _write(t, body)
    audit_superadmin(
        db, user, action="update_bank_rule_template",
        target_type="bank_rule_template", target_id=str(t.id),
        details=f"{t.name} → {t.target_kind}" + ("" if t.enabled else " (hidden)"),
    )
    db.commit()
    return BankRuleTemplateResponse(
        template=_row(t, _labels(template_category_groups(db))),
    )


@superadmin_router.delete("/{template_id}", status_code=204)
def delete_template_route(
    template_id: int = Path(..., ge=1),
    db: Session = Depends(get_db),
    claims: dict[str, Any] = Depends(get_principal),
) -> None:
    """Deletes the template only. Rules stores already made from it
    are their own rows and stay."""
    user = resolve_superadmin_user(db, claims)
    t = _find(db, template_id)
    audit_superadmin(
        db, user, action="delete_bank_rule_template",
        target_type="bank_rule_template", target_id=str(t.id),
        details=t.name,
    )
    db.delete(t)
    db.commit()

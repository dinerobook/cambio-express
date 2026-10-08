"""Pydantic schemas for the platform store CRUD endpoints.

Drives the `/app/superadmin/stores/new` + `/app/superadmin/stores/:id/edit`
React forms. Mirrors the legacy `superadmin_new_store` Flask handler's
field set so the SPA covers every input the Jinja form had:

  - Identity: name, slug, email, phone, address.
  - Plan: one of trial / basic / pro / inactive (legacy form
    only exposes the first three at create time, but PATCH must
    accept inactive too so the comp-plan / revert-to-trial flows
    can route through this surface later if needed).
  - Initial admin user (create only): admin_username, admin_name,
    admin_password — all optional with defaults that match the
    legacy form (admin / Store Admin / changeme123!).
"""
import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# Plan vocabulary — kept aligned with `Store.plan ∈ {trial, basic,
# pro, inactive}` per CLAUDE.md invariant #3. Any new plan needs to
# update this regex AND `get_trial_status` simultaneously.
_PLAN_PATTERN = r"^(trial|basic|pro|inactive)$"

# Server-side email shape check — parity with the SPA's shared
# validators lib (`frontend/src/lib/validators.ts`). The server is the
# real trust boundary, so the same rule is enforced here regardless of
# what the client sent. Pragmatic shape (one @, a dotted domain), not
# full RFC 5322 — real deliverability is proven by the confirmation
# email, not this regex. Empty is allowed (email is optional on a store).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_optional_email(v: str | None) -> str | None:
    """Reusable field-validator body: pass through None / "" (optional),
    else require a valid email shape."""
    if v is None:
        return v
    if v.strip() and not _EMAIL_RE.match(v.strip()):
        raise ValueError("Enter a valid email address")
    return v


class SuperadminStoreDetailRow(BaseModel):
    """Full store payload for the edit form prefill.

    Superset of `SuperadminStoreRow` (the list-view row): adds
    address + federal_tax_rate which the form needs but the table
    doesn't render."""
    model_config = ConfigDict(extra="forbid")

    store_id: int
    name: str
    slug: str
    email: str
    phone: str
    address: str
    plan: str
    business_type: str
    billing_cycle: str
    is_active: bool
    federal_tax_rate: float
    created_at: str
    trial_ends_at: str
    grace_ends_at: str
    data_retention_until: str
    stripe_customer_id: str
    stripe_subscription_id: str


class SuperadminStoreDetailResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    store: SuperadminStoreDetailRow


class SuperadminStoreCreateRequest(BaseModel):
    """POST body for /superadmin/stores.

    Identity fields mirror the Jinja form's required set: `name` and
    `slug` are mandatory; the rest default to empty strings (matches
    the legacy ``request.form.get("phone","")`` style). `plan`
    accepts any of the four canonical values though the legacy form
    only ever submitted trial / basic / pro.

    The initial admin user is also created in the same transaction.
    Defaults match the legacy handler so an operator can submit just
    name + slug + admin_password and get a usable store back —
    `admin_username` falls back to "admin", `admin_name` to "Store
    Admin", and `admin_password` is required (the legacy fallback to
    "changeme123!" was a footgun and is dropped here)."""
    model_config = ConfigDict(extra="forbid")

    name:    str = Field(..., min_length=1, max_length=120)
    slug:    str = Field(..., min_length=1, max_length=60)
    email:   str = Field("",  max_length=120)
    phone:   str = Field("",  max_length=40)
    address: str = Field("",  max_length=255)
    plan:    str = Field("trial", pattern=_PLAN_PATTERN)
    business_type: str = Field("cstore", pattern="^(cstore|gas_station|grocery|msb_hybrid)$")

    admin_username: str = Field("admin",       min_length=1, max_length=80)
    admin_name:     str = Field("Store Admin", max_length=120)
    admin_password: str = Field(..., min_length=1, max_length=200)
    # U-5b concierge onboarding: "owner" makes the initial user a
    # role=owner with this store as their home (plus the
    # StoreOwnerLink row) — the same shape self-service signup
    # creates — so the customer gets store switching + user
    # management from day one. "admin" keeps the legacy behavior.
    initial_role: str = Field("admin", pattern="^(admin|owner)$")

    _v_email = field_validator("email")(_validate_optional_email)


class SuperadminOwnerLinkRow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    owner_id:  int
    username:  str
    full_name: str
    is_active: bool
    linked_at: str  # ISO; "" when unknown


class SuperadminOwnerLinkListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rows: list[SuperadminOwnerLinkRow]


class SuperadminOwnerLinkCreateRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/owner-links — connect
    an existing owner login to a store on the customer's
    instruction (concierge onboarding)."""
    model_config = ConfigDict(extra="forbid")

    owner_username: str = Field(..., min_length=1, max_length=255)


class SuperadminStoreUpdateRequest(BaseModel):
    """PATCH body for /superadmin/stores/{id}.

    Every field is optional — clients pass only what they want to
    change. Slug uniqueness is enforced at the route level (a
    duplicate returns 409 with `field=slug`).

    `plan` is included because the legacy form drops the operator
    on a /new page that lets them pick the plan before save; the
    edit page needs the same affordance so a comped store can be
    moved between plans without going through Stripe."""
    model_config = ConfigDict(extra="forbid")

    name:             str   | None = Field(None, min_length=1, max_length=120)
    slug:             str   | None = Field(None, min_length=1, max_length=60)
    email:            str   | None = Field(None, max_length=120)
    phone:            str   | None = Field(None, max_length=40)
    address:          str   | None = Field(None, max_length=255)
    plan:             str   | None = Field(None, pattern=_PLAN_PATTERN)
    business_type:    str   | None = Field(None, pattern="^(cstore|gas_station|grocery|msb_hybrid)$")
    federal_tax_rate: float | None = Field(None, ge=0.0, le=1.0)

    _v_email = field_validator("email")(_validate_optional_email)


class SuperadminStoreCreditRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/credit.

    Issues a goodwill credit to the store's Stripe customer balance.
    `amount_cents` is the POSITIVE size of the credit in cents; the
    Service negates it for Stripe (negative balance transaction =
    credit). The upper bound mirrors ``credits.MAX_CREDIT_CENTS``
    ($5,000) — a single make-good credit is a manual one-off, not a
    bulk operation, so the fat-finger guardrail lives here too (and
    is re-checked in the Service as the source of truth).

    `reason` is optional operator context; it flows into both the
    Stripe transaction description (visible in the Stripe dashboard)
    and the audit log details."""
    model_config = ConfigDict(extra="forbid")

    amount_cents: int = Field(..., ge=1, le=500_000)
    reason:       str = Field("", max_length=200)


class SuperadminStoreCreditResponse(BaseModel):
    """Result of a successful credit. `stripe_txn_id` is the balance
    transaction id (empty only if Stripe returned no id — the credit
    still posted). The SPA shows a success toast keyed off `ok`."""
    model_config = ConfigDict(extra="forbid")

    ok:            bool
    amount_cents:  int
    stripe_txn_id: str


class SuperadminStoreFreezeRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/freeze (PR C).

    Suspends a store — the SPA gates its users to a "suspended, contact
    support" screen. Distinct from trial-expired and retention-pause.
    `reason` is operator context (abuse, dispute, non-payment) recorded
    in the audit log + shown in the superadmin UI; it is NOT surfaced to
    the store's users."""
    model_config = ConfigDict(extra="forbid")

    reason: str = Field("", max_length=200)


class SuperadminStoreFreezeResponse(BaseModel):
    """Result of a freeze/unfreeze. `frozen` reflects the store's new
    state; `frozen_at` is the ISO timestamp (empty when unfrozen)."""
    model_config = ConfigDict(extra="forbid")

    ok:            bool
    frozen:        bool
    frozen_at:     str
    frozen_reason: str


class SuperadminExtendTrialRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/extend-trial and the
    ``days`` of the bulk ``extend_trial`` action.

    ``days`` adds to the later of the current trial end and now
    (so an expired store really gets N days); ``ends_on`` sets the
    end to that calendar day instead and wins when both are sent.
    The arithmetic lives in ``Superadmin.Services.trials``."""
    model_config = ConfigDict(extra="forbid")

    days:    int = Field(14, ge=1, le=365)
    ends_on: date | None = None


class SuperadminExtendTrialResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok:            bool
    plan:          str
    trial_ends_at: str
    grace_ends_at: str
    trial_status:  str


class SuperadminBulkActionRequest(BaseModel):
    """POST body for /superadmin/bulk-action."""
    model_config = ConfigDict(extra="forbid")

    store_ids: list[int] = Field(..., min_length=1, max_length=500)
    action:    Literal["extend_trial", "enable", "disable"]
    days:      int = Field(14, ge=1, le=365)


class SuperadminChangeRoleRequest(BaseModel):
    """POST body for /superadmin/users/{id}/change-role. The store
    roles only — superadmin and support logins are created through
    their own paths and never converted."""
    model_config = ConfigDict(extra="forbid")

    role: Literal["admin", "employee", "owner"]


class SuperadminImpersonateRequest(BaseModel):
    """POST body for /superadmin/impersonate/{id}. ``read_only``
    mints a token every write is refused on (see
    ``api.Core.ReadOnlyImpersonation``)."""
    model_config = ConfigDict(extra="forbid")

    mode: Literal["full", "read_only"] = "full"


class SuperadminCompPlanRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/comp-plan."""
    model_config = ConfigDict(extra="forbid")

    plan:   Literal["basic", "pro"]
    reason: str = Field("", max_length=200)


class SuperadminCompPlanResponse(BaseModel):
    """State after a comp / end-comp. ``stripe_paused`` /
    ``stripe_resumed`` say whether a subscription was touched."""
    model_config = ConfigDict(extra="forbid")

    ok:             bool
    plan:           str
    billing_cycle:  str
    comped:         bool
    comped_at:      str
    comp_reason:    str
    stripe_paused:  bool = False
    stripe_resumed: bool = False


class SuperadminStoreFeatureRow(BaseModel):
    """One module / add-on / platform flag as it applies to ONE
    store. ``default`` is what the store gets with no override
    (the business-type bundle for ``module_*`` keys, the global
    default otherwise); ``override`` is the per-store value when
    one is set; ``effective`` is what the store's users see now."""
    model_config = ConfigDict(extra="forbid")

    key:         str
    label:       str
    description: str
    kind:        Literal["module", "addon", "flag"]
    default:     bool
    override:    bool | None
    effective:   bool


class SuperadminStoreFeatureListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    store_id:      int
    business_type: str
    rows:          list[SuperadminStoreFeatureRow]


class SuperadminMaintenanceRequest(BaseModel):
    """POST body for /superadmin/maintenance."""
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    message: str = Field("", max_length=500)


class SuperadminStoreEmailRequest(BaseModel):
    """POST body for /superadmin/stores/{id}/email — one message to
    every active admin of the store who has an email address."""
    model_config = ConfigDict(extra="forbid")

    subject: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=5000)


__all__ = [
    "SuperadminBulkActionRequest",
    "SuperadminChangeRoleRequest",
    "SuperadminCompPlanRequest",
    "SuperadminCompPlanResponse",
    "SuperadminExtendTrialRequest",
    "SuperadminImpersonateRequest",
    "SuperadminExtendTrialResponse",
    "SuperadminMaintenanceRequest",
    "SuperadminStoreCreateRequest",
    "SuperadminStoreCreditRequest",
    "SuperadminStoreCreditResponse",
    "SuperadminStoreDetailResponse",
    "SuperadminStoreDetailRow",
    "SuperadminStoreFreezeRequest",
    "SuperadminStoreFeatureListResponse",
    "SuperadminStoreEmailRequest",
    "SuperadminStoreFeatureRow",
    "SuperadminStoreFreezeResponse",
    "SuperadminStoreUpdateRequest",
]

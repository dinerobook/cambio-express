"""Comp plan: a paid plan the store does not pay for.

A superadmin comps a store (a beta partner, a make-good, a friend of
the business) by putting it on ``basic`` / ``pro`` with
``billing_cycle = "comp"`` and stamping ``comped_at`` +
``comp_reason``. If the store has a Stripe subscription, collection
is PAUSED (``pause_collection.behavior = void``: invoices are
generated and voided, nothing is charged) rather than cancelled, so
ending the comp is one resume call and the customer keeps their
billing history. Stripe is called BEFORE any row changes, so a
Stripe failure leaves the store exactly as it was.

Ending a comp resumes collection and re-derives the plan + cycle
from the subscription's price; a store that never paid goes back to
a fresh trial window (``apply_plan_change``) so it is neither gated
out nor silently free.

The webhook side (``Billing.Services.cancellation`` /
``webhook``): a Stripe cancellation leaves a comped store alone, and
a completed checkout ends the comp.
"""
from __future__ import annotations

import logging
from typing import Any

import stripe

from api.Core.Clock import utc_now
from api.Modules.Billing.Services.checkout import StripeServiceError
from api.Modules.Billing.Services.config import require_stripe_configured
from api.Modules.Superadmin.Services.trials import apply_plan_change

logger = logging.getLogger(__name__)

COMP_CYCLE = "comp"
COMP_PLANS = ("basic", "pro")


class NotCompedError(ValueError):
    """``end_comp`` on a store that is not comped."""


def is_comped(store: Any) -> bool:
    return getattr(store, "comped_at", None) is not None


def comp_store(store: Any, *, plan: str, reason: str) -> dict[str, Any]:
    """Put ``store`` on ``plan`` for free. Returns
    ``{"stripe_paused": bool, "changed": [...]}``. Raises
    ``StripeNotConfiguredError`` when a subscription exists but
    Stripe is not configured, ``StripeServiceError`` when Stripe
    refuses the pause, ``ValueError`` on a non-paid plan."""
    if plan not in COMP_PLANS:
        raise ValueError(f"Only {', '.join(COMP_PLANS)} can be comped.")
    sub_id = store.stripe_subscription_id or ""
    paused = False
    if sub_id:
        require_stripe_configured()
        try:
            stripe.Subscription.modify(
                sub_id, pause_collection={"behavior": "void"},
            )
        except Exception as exc:  # stripe.StripeError and friends
            logger.error("comp: pause of %s failed: %s", sub_id, exc)
            raise StripeServiceError(f"Stripe refused the pause: {exc}") from exc
        paused = True
    changed = apply_plan_change(store, plan)
    store.billing_cycle = COMP_CYCLE
    store.comped_at = utc_now()
    store.comp_reason = (reason or "").strip()[:200]
    changed += ["billing_cycle", "comped_at", "comp_reason"]
    return {"stripe_paused": paused, "changed": changed}


def end_comp(store: Any) -> dict[str, Any]:
    """Take the comp off. With a subscription: resume collection and
    put the plan back to what the subscription's price says. Without
    one: a fresh trial window. Returns ``{"stripe_resumed": bool}``."""
    if not is_comped(store):
        raise NotCompedError("This store is not comped.")
    sub_id = store.stripe_subscription_id or ""
    resumed = False
    if sub_id:
        require_stripe_configured()
        try:
            stripe.Subscription.modify(sub_id, pause_collection="")
        except Exception as exc:
            logger.error("comp: resume of %s failed: %s", sub_id, exc)
            raise StripeServiceError(f"Stripe refused the resume: {exc}") from exc
        resumed = True
        plan, cycle = _plan_from_subscription(sub_id, fallback=store.plan or "pro")
        store.plan = plan
        store.billing_cycle = cycle
    else:
        store.billing_cycle = ""
        apply_plan_change(store, "trial")
    store.comped_at = None
    store.comp_reason = ""
    return {"stripe_resumed": resumed}


def _plan_from_subscription(sub_id: str, *, fallback: str) -> tuple[str, str]:
    """``(plan, cycle)`` from the subscription's first price; on any
    Stripe hiccup keep the plan the store already had, monthly."""
    from api.Modules.Billing.Services.webhook import derive_plan_from_price
    try:
        sub = stripe.Subscription.retrieve(sub_id)
        price_id = sub["items"]["data"][0]["price"]["id"]
        return derive_plan_from_price(price_id)
    except Exception as exc:
        logger.warning("comp: could not read %s after resume: %s", sub_id, exc)
        return (fallback if fallback in COMP_PLANS else "pro"), "monthly"


__all__ = [
    "COMP_CYCLE", "COMP_PLANS", "NotCompedError",
    "comp_store", "end_comp", "is_comped",
]

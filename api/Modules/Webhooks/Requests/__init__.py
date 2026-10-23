"""Webhook receiver answers."""
from pydantic import BaseModel, ConfigDict


class WebhookAck(BaseModel):
    """Delivery accepted. ``warning`` is set when the event was
    recorded but its handler failed (the sender must not retry a
    handler bug). A bad signature or body answers 400
    ``{"error": …}`` instead."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    warning: str | None = None

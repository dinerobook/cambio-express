"""Passkey ceremony answers shared by the sign-in passkeys and the
time-clock roster passkeys."""
from pydantic import BaseModel, ConfigDict


class PasskeyRegisterBeginResponse(BaseModel):
    """Step one of a WebAuthn registration: the browser options (a
    JSON string for ``navigator.credentials.create()``) and the
    signed token the client echoes back on ``/register/finish``."""

    model_config = ConfigDict(extra="forbid")

    options_json: str
    register_token: str

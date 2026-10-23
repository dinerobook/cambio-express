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


class PasskeyCreated(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str
    created_at: str
    last_used_at: str


class PasskeyRegisterFinishResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passkey: PasskeyCreated


class PasskeyRow(PasskeyCreated):
    aaguid: str
    transports: str


class PasskeyListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    passkeys: list[PasskeyRow]
    total: int

"""Answers shared by routes in many modules.

A route whose whole answer is ``{"ok": true}`` documents it with
``OkResponse`` instead of a module-local copy (api/CLAUDE.md →
"Every JSON answer documents its shape").
"""
from pydantic import BaseModel, ConfigDict


class OkResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool


class MaintenanceState(BaseModel):
    """Maintenance mode as the public banner and the superadmin
    switch both read it."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    message: str


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    version: str

"""Saved access roles — request schemas.

The matrix bodies reuse the shared permission-matrix types so a
malformed grid is a 422 here, exactly as on the store-permissions
route, instead of a 500 out of the writer."""
from pydantic import BaseModel, ConfigDict, Field

from api.Core.Permissions.matrix_update import RoleMatrix


class RoleCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, max_length=80)
    matrix: RoleMatrix


class RoleUpdateRequest(BaseModel):
    """PATCH semantics — an omitted field stays unchanged."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, min_length=1, max_length=80)
    matrix: RoleMatrix | None = None


class AssignRoleRequest(BaseModel):
    """``role_id: null`` takes the person out of their saved role."""

    model_config = ConfigDict(extra="forbid")

    role_id: int | None = Field(None, ge=1)

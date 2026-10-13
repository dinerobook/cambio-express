"""add msb_transfer.client_request_id

The New Transfer form sends a key it generates once per form
(``Idempotency-Key`` header). Saving the same form again (a retry
after a dropped connection or a server error that came after the
commit) returns the transfer that key already created instead of
logging a second copy.

Additive only: a nullable column with no default plus a unique index
on ``(store_id, client_request_id)``. Every existing row keeps NULL,
and NULLs never collide in a unique index (Postgres and SQLite), so
existing rows and every caller that sends no key behave exactly as
before.

Idempotent add (survives a replay where the column already exists).

Revision ID: c8e1a5d3f7b2
Revises: a7d4c2f9e1b3
Create Date: 2026-10-13 07:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


# revision identifiers, used by Alembic.
revision: str = 'c8e1a5d3f7b2'
down_revision: Union[str, None] = 'a7d4c2f9e1b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "msb_transfer"
_COLUMN = "client_request_id"
_INDEX = "ux_msb_transfer_store_client_request_id"


def upgrade() -> None:
    insp = inspect(op.get_bind())
    if _COLUMN not in {c["name"] for c in insp.get_columns(_TABLE)}:
        op.add_column(_TABLE, sa.Column(_COLUMN, sa.String(64), nullable=True))
    if _INDEX not in {i["name"] for i in insp.get_indexes(_TABLE)}:
        op.create_index(
            _INDEX, _TABLE, ["store_id", _COLUMN], unique=True,
        )


def downgrade() -> None:
    insp = inspect(op.get_bind())
    if _INDEX in {i["name"] for i in insp.get_indexes(_TABLE)}:
        op.drop_index(_INDEX, table_name=_TABLE)
    if _COLUMN in {c["name"] for c in insp.get_columns(_TABLE)}:
        with op.batch_alter_table(_TABLE) as batch:
            batch.drop_column(_COLUMN)

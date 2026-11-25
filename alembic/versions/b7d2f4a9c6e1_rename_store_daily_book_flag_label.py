"""the Retail daily book is named "Daily book": rename its module flag's label

The owner renamed the Retail page from "Store daily book" to "Daily
book" (2026-11-23). The sidebar, the page and the permission grid take
their words from the SPA, but Platform → Feature flags shows each
flag's label from its own row, and the boot seed only ever ADDS rows
(so a superadmin's settings survive a deploy). The row that already
exists therefore keeps saying "Module: Store daily book" unless it is
renamed here.

Data only, one row, and only while the label is still the old default:
a label somebody changed by hand is left alone. Nothing is added or
dropped. The table and column names are spelled out (a migration never
imports application code). Idempotent both ways.

Revision ID: b7d2f4a9c6e1
Revises: a4c9e2f7b3d1
Create Date: 2026-11-23 00:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7d2f4a9c6e1'
down_revision: Union[str, None] = 'a4c9e2f7b3d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TABLE = "billing_feature_flag"
FLAG_KEY = "module_day_close"
OLD_LABEL = "Module: Store daily book"
NEW_LABEL = "Module: Daily book"


def _rename(old: str, new: str) -> None:
    if TABLE not in sa.inspect(op.get_bind()).get_table_names():
        return
    flag = sa.table(
        TABLE, sa.column("key", sa.String), sa.column("label", sa.String),
    )
    op.execute(
        flag.update()
        .where(flag.c.key == FLAG_KEY, flag.c.label == old)
        .values(label=new)
    )


def upgrade() -> None:
    _rename(OLD_LABEL, NEW_LABEL)


def downgrade() -> None:
    _rename(NEW_LABEL, OLD_LABEL)

"""The revision graph must end in exactly one head.

``init_db()`` runs ``alembic upgrade head`` on every boot. Two
revisions that both name the same ``down_revision`` (two branches each
adding a migration off the same parent, merged one after the other)
leave two heads, and ``upgrade head`` then refuses to run: the app does
not start. Whichever branch merges second re-points its revision's
``down_revision`` at the other's revision before it merges.
"""
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[2]


def test_one_alembic_head():
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert len(heads) == 1, (
        f"Alembic has {len(heads)} heads {sorted(heads)}: re-point the newer "
        "revision's down_revision at the other one."
    )

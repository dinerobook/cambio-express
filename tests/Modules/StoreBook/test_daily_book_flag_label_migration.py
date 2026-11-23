"""The Retail page is named "Daily book" (owner, 2026-11-23). Its module
flag's label lives in a row the boot seed never rewrites, so revision
b7d2f4a9c6e1 renames it: only while the label is still the old default,
without importing application code, and safely run twice or undone."""
import importlib.util
from pathlib import Path

import pytest

from api.Core.Bootstrap import DEFAULT_FEATURE_FLAGS
from api.Modules.Billing.Models import FeatureFlag

ROOT = Path(__file__).resolve().parents[3]
PATH = (
    ROOT / "alembic" / "versions"
    / "b7d2f4a9c6e1_rename_store_daily_book_flag_label.py"
)


def _load():
    spec = importlib.util.spec_from_file_location(PATH.stem, PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_names_the_real_table_and_the_seeded_label():
    """The literal names in the revision are the model's, and the new
    label is the one a fresh database is seeded with."""
    m = _load()
    assert m.TABLE == FeatureFlag.__tablename__
    assert {"key", "label"} <= {c.name for c in FeatureFlag.__table__.columns}
    seeded = {key: label for key, label, _desc, _on in DEFAULT_FEATURE_FLAGS}
    assert seeded[m.FLAG_KEY] == m.NEW_LABEL


def test_migration_does_not_import_application_code():
    for line in PATH.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert not stripped.startswith(("import api", "from api")), stripped


@pytest.mark.parametrize("label, after_upgrade", [
    ("Module: Store daily book", "Module: Daily book"),
    # A label somebody changed by hand is theirs.
    ("Module: Retail books", "Module: Retail books"),
])
def test_only_the_old_default_label_is_renamed(
    tmp_path, monkeypatch, label, after_upgrade,
):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text

    m = _load()
    url = f"sqlite:///{tmp_path / 'flag.db'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_engine(url)

    def labels():
        with engine.connect() as conn:
            return dict(conn.execute(text(
                "SELECT key, label FROM billing_feature_flag ORDER BY key"
            )).all())

    command.upgrade(cfg, m.down_revision)
    with engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO billing_feature_flag "
            "(key, label, description, enabled_by_default) VALUES "
            "('module_day_close', :label, '', 1), "
            "('module_lottery', 'Module: Lottery', '', 1)"
        ), {"label": label})

    for _ in range(2):
        command.upgrade(cfg, m.revision)
        assert labels() == {
            "module_day_close": after_upgrade,
            "module_lottery": "Module: Lottery",
        }

    for _ in range(2):
        command.downgrade(cfg, m.down_revision)
        assert labels() == {
            "module_day_close": label,
            "module_lottery": "Module: Lottery",
        }

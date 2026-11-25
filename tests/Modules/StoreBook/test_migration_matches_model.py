"""The Store Daily Book migration spells its columns out literally
rather than importing them from the model.

That is deliberate — a migration must be immutable, so renaming a
model field later must not change what a historical revision
creates. The cost of that choice is two lists that could drift, so
this test is the thing that stops them.
"""
import importlib.util
from pathlib import Path

from api.Modules.StoreBook.Models import COUNT_FIELDS, MONEY_FIELDS

_VERSIONS = Path(__file__).resolve().parents[3] / "alembic" / "versions"
_MIGRATION = _VERSIONS / "f2b8d4e6a1c7_add_store_daily_entry.py"
# Lines added to the sheet later, each by its own revision.
_LATER = (
    _VERSIONS / "a4c9e2f7b3d1_add_store_daily_fee_lines.py",
)


def _load(path: Path = _MIGRATION):
    spec = importlib.util.spec_from_file_location(
        f"sde_migration_{path.stem}", path,
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_creates_exactly_the_model_money_columns():
    """The first revision's lines plus every later revision's, each
    created once, are the model's lines. Page order is the model's
    business; the columns are what must agree."""
    created = list(_load()._MONEY_FIELDS)
    for path in _LATER:
        created += list(_load(path)._MONEY_FIELDS)
    assert len(created) == len(set(created))
    assert sorted(created) == sorted(MONEY_FIELDS)


def test_migration_creates_exactly_the_model_count_columns():
    assert tuple(_load()._COUNT_FIELDS) == tuple(COUNT_FIELDS)


def test_migration_does_not_import_application_code():
    """Alembic loads every version file to build the revision graph,
    and init_db() runs that during app boot — a top-level app import
    here drags the model layer into the boot path from inside the
    migration loader."""
    for path in (_MIGRATION, *_LATER):
        for line in path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith(("import ", "from ")):
                assert not stripped.startswith(
                    ("import api", "from api"),
                ), f"{path.name} imports application code: {stripped}"

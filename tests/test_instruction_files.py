"""The instruction files Claude Code loads must stay accurate and complete.

The rules are split across the root ``CLAUDE.md`` (always loaded) and
nested ``CLAUDE.md`` files that load when a file in their folder is read.
These checks stop the split from quietly dropping a rule or pointing at
a file that no longer exists.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

INSTRUCTION_FILES = sorted(
    p
    for p in ROOT.rglob("CLAUDE.md")
    if "node_modules" not in p.parts and ".git" not in p.parts
)

# Paths inside backticks that start at one of these roots are checked.
_PATH_ROOTS = (
    "api/", "frontend/", "docs/", "tests/", "alembic/", "scripts/",
    "static/", "templates/",
)
_BACKTICK = re.compile(r"`([^`\s]+)`")
# Named on purpose as things that must NOT exist (removed / never committed).
_ABSENT_ON_PURPOSE = {"api/Flask/", "frontend/dist"}


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _named_paths(path: Path) -> list[str]:
    out = []
    for token in _BACKTICK.findall(_text(path)):
        token = token.rstrip(".,:;)")
        if any(ch in token for ch in "<>{}*"):
            continue
        if token.startswith(_PATH_ROOTS) and token not in _ABSENT_ON_PURPOSE:
            out.append(token)
    return out


def _resolve(named: str, source: Path) -> bool:
    """A path resolves from the repo root, or from the file's own folder
    (``frontend/CLAUDE.md`` says ``src/...``)."""
    return (ROOT / named).exists() or (source.parent / named).exists()


def test_instruction_files_found() -> None:
    names = {p.relative_to(ROOT).as_posix() for p in INSTRUCTION_FILES}
    for expected in (
        "CLAUDE.md",
        "api/CLAUDE.md",
        "frontend/CLAUDE.md",
        "alembic/CLAUDE.md",
    ):
        assert expected in names


def test_every_named_path_exists() -> None:
    missing = [
        f"{p.relative_to(ROOT)}: {named}"
        for p in INSTRUCTION_FILES
        for named in _named_paths(p)
        if not _resolve(named, p)
    ]
    assert not missing, "instruction files name missing paths:\n" + "\n".join(missing)


def test_frontend_relative_paths_exist() -> None:
    src = ROOT / "frontend"
    missing = [
        token
        for token in _BACKTICK.findall(_text(src / "CLAUDE.md"))
        if token.startswith("src/") and not any(c in token for c in "<>{}*")
        and not (src / token.rstrip(".,:;)")).exists()
    ]
    assert not missing, missing


def test_every_invariants_file_is_imported_by_its_module() -> None:
    for inv in sorted((ROOT / "api" / "Modules").glob("*/INVARIANTS.md")):
        claude = inv.parent / "CLAUDE.md"
        assert claude.exists(), f"{inv.parent.name} has INVARIANTS.md but no CLAUDE.md"
        assert "@INVARIANTS.md" in _text(claude), (
            f"{claude.relative_to(ROOT)} must import @INVARIANTS.md"
        )


def test_no_instruction_file_in_the_design_export() -> None:
    # The claude.ai/design export carried a Flask-era CLAUDE.md that
    # auto-loaded stale rules whenever a kit file was read.
    stale = list((ROOT / "docs" / "design-system" / "project").rglob("CLAUDE.md"))
    assert not stale, stale


def test_root_lists_every_invariant_and_stays_short() -> None:
    root = _text(ROOT / "CLAUDE.md")
    for n in range(1, 23):
        # 119 code / test comments cite "invariant N" — the numbering stays.
        assert re.search(rf"^{n}\. \*\*", root, re.M), f"invariant {n} missing"
    assert len(root.encode("utf-8")) < 20_000, "root CLAUDE.md is loaded every session; keep it short"


# One token per rule the old single CLAUDE.md carried. Each must survive
# somewhere in the instruction files.
KEY_RULES = (
    "allow_promotion_codes=True",
    "db.session.get",
    "_TRIAL_EXEMPT",
    "_STORE_OWNED_MODELS",
    "record_audit",
    "find_or_upsert_customer",
    "store_feature_enabled",
    "total_collected = send_amount",
    "sha256",
    "needs_totp",
    "useUrlFilterState",
    "client_ip",
    "enqueue",
    "SameSite=Lax",
    "ranks.py",
    "authorize_store_id",
    "PUBLIC",
    "allow_inf_nan",
    "with_page_security_headers",
    "MODULE_PREFIX",
    "useUnsavedGuard",
    "access.ts",
    "PageCrumbs",
    "#3fff00",
    "Space Grotesk",
    "RowActions",
    "react-hook-form",
    "generate-types",
    "cashnet",
    "BUILTIN_BANK_RULES",
    "WEBAUTHN_RP_ID",
    "save_policy()",
)


def test_key_rules_survive() -> None:
    corpus = "\n".join(_text(p) for p in INSTRUCTION_FILES)
    missing = [rule for rule in KEY_RULES if rule not in corpus]
    assert not missing, f"rules dropped from the instruction files: {missing}"

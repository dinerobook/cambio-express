"""The SPA translates a few server sentences by their exact English
text (frontend/src/i18n/serverMessages.ts, UI-STANDARDS §10).

Pinned here: every sentence that table lists still appears somewhere
in the API source. If the server rewords one, this fails so the table
is updated in the same change, instead of Spanish users silently
getting English for it.
"""
import pathlib
import re

_ROOT = pathlib.Path(__file__).resolve().parents[3]
_TABLE = _ROOT / "frontend" / "src" / "i18n" / "serverMessages.ts"


def _listed_sentences() -> list[str]:
    src = _TABLE.read_text()
    body = src[src.index("SERVER_MESSAGES"):]
    body = body[: body.index("};")]
    return re.findall(r'^\s*"([^"]+)":\s*"[\w.]+",\s*$', body, re.M)


def _api_source() -> str:
    return "\n".join(
        p.read_text() for p in (_ROOT / "api").rglob("*.py")
    )


def test_table_is_found_and_not_empty():
    assert len(_listed_sentences()) >= 3


def test_every_listed_sentence_is_still_sent_by_the_api():
    api = _api_source()
    missing = [s for s in _listed_sentences() if s not in api]
    assert missing == [], (
        "frontend/src/i18n/serverMessages.ts lists sentences the API no "
        f"longer sends: {missing}. Update the table with the new wording."
    )

"""Regression guard for design-system token references.

Every ``var(--db-...)`` lookup in the SPA frontend must resolve
to a token actually declared in ``static/design-tokens.css``. A
missing declaration silently falls through to the hardcoded hex
fallback — which is always dark — and the theme toggle becomes a
no-op (which is the exact bug we hit in PR #589).

This test scans the frontend bundle for every ``var(--db-…)``
reference and fails if any of them isn't declared in
``design-tokens.css``. Catches typos like ``--db-surface-1`` vs
``--db-surface`` before they ship.
"""
import re
from pathlib import Path


REPO_ROOT       = Path(__file__).parent.parent
TOKENS_CSS_PATH = REPO_ROOT / "static" / "design-tokens.css"
FRONTEND_SRC    = REPO_ROOT / "frontend" / "src"

# ``var(--db-foo)`` references in any frontend source file.
_USE_RE = re.compile(r"var\((--db-[a-z0-9-]+)")
# ``--db-foo:`` declarations on the left-hand side of a CSS line.
_DEF_RE = re.compile(r"(--db-[a-z0-9-]+)\s*:")

# File extensions the SPA can stash a CSS-var reference in.
_SCAN_EXTS = (".tsx", ".ts", ".css")


def _declared_tokens() -> set[str]:
    css = TOKENS_CSS_PATH.read_text(encoding="utf-8")
    return set(_DEF_RE.findall(css))


def _referenced_tokens() -> dict[str, list[Path]]:
    """Return ``{token: [files that reference it]}`` so a failure
    message can point the reader at the offending call sites."""
    refs: dict[str, list[Path]] = {}
    for ext in _SCAN_EXTS:
        for path in FRONTEND_SRC.rglob(f"*{ext}"):
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            for token in _USE_RE.findall(text):
                refs.setdefault(token, []).append(path)
    return refs


def test_every_frontend_token_reference_is_declared():
    declared = _declared_tokens()
    referenced = _referenced_tokens()
    missing = {
        tok: paths for tok, paths in referenced.items()
        if tok not in declared
    }
    if missing:
        lines = ["Frontend references undefined design tokens:"]
        for tok, paths in sorted(missing.items()):
            rel = sorted({p.relative_to(REPO_ROOT) for p in paths})
            lines.append(f"  {tok}  — used in: {', '.join(str(p) for p in rel)}")
        lines.append(
            "Either declare the token in static/design-tokens.css "
            "(inside :root) or change the call site to a token that "
            "exists. Undefined tokens fall through to their hardcoded "
            "hex fallback — that breaks the dark/light toggle."
        )
        raise AssertionError("\n".join(lines))


# ── One palette, two themes (2026-10-15) ─────────────────────────────
#
# The owner found the public pages' top bar stayed near-black in light
# mode: it was a hardcoded ``rgba(11, 13, 18, 0.85)``. The rules below
# keep every colour in ``static/design-tokens.css`` so the light block
# there can flip it.

# A colour literal: #rgb / #rrggbb / #rrggbbaa, or an rgb()/hsl() call
# built from numbers (``rgba(var(--x-rgb), .1)`` is a token, not a
# literal, and is allowed).
_COLOUR_RE = re.compile(
    r"#[0-9a-fA-F]{3,8}\b(?![-\w])"
    r"|\b(?:rgba?|hsla?)\(\s*\d"
)

# Files that may hold a colour literal, and why. Keep this list short:
# a new entry needs a reason a token cannot serve.
_COLOUR_LITERAL_ALLOWED = {
    # Chart.js paints on a canvas and needs a concrete colour; each
    # literal is the fallback when the CSS variable cannot be read
    # (jsdom in tests). ``rgba(${rgb}, …)`` is built from a token.
    "frontend/src/lib/chartOptions.ts",
    # The <meta name="theme-color"> value per theme; pinned to the
    # tokens' --db-bg values by test_theme_chrome_colours_match_tokens.
    "frontend/src/lib/theme.ts",
}


def _frontend_sources():
    for ext in _SCAN_EXTS:
        for path in FRONTEND_SRC.rglob(f"*{ext}"):
            if ".test." in path.name or "openapi" in path.name:
                continue
            yield path


def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    # ``//`` line comments, but not the ``//`` inside a URL.
    return re.sub(r"(?<![:\"'])//[^\n]*", "", text)


def test_no_colour_literals_outside_design_tokens():
    offenders = []
    for path in _frontend_sources():
        rel = str(path.relative_to(REPO_ROOT))
        if rel in _COLOUR_LITERAL_ALLOWED:
            continue
        text = _strip_comments(path.read_text(encoding="utf-8"))
        for lineno, line in enumerate(text.splitlines(), 1):
            if _COLOUR_RE.search(line):
                offenders.append(f"  {rel}: {line.strip()[:120]}")
    assert not offenders, (
        "Colour literals in the SPA (use a --db-* token from "
        "static/design-tokens.css; add one there, with its light-mode "
        "value, if none fits):\n" + "\n".join(offenders)
    )


def test_no_token_fallbacks():
    """``var(--db-x, #0a0a0a)`` is a dark-only hex hiding behind a
    token: it never applies while the token exists, and paints dark
    on a light page the day it doesn't. Every token is declared
    (test above), so a fallback is dead code at best."""
    offenders = []
    for path in _frontend_sources():
        text = path.read_text(encoding="utf-8")
        for m in re.finditer(r"var\((--db-[a-z0-9-]+)\s*,", text):
            offenders.append(f"  {path.relative_to(REPO_ROOT)}: {m.group(0)}")
    assert not offenders, "Token fallbacks:\n" + "\n".join(offenders)


def test_every_custom_property_reference_is_declared():
    """Non-``--db-`` variables too: ``var(--text-muted)`` (no such
    variable) silently fell back to the inherited colour."""
    declared = set(re.findall(r"(--[a-zA-Z0-9-]+)\s*:",
                              TOKENS_CSS_PATH.read_text(encoding="utf-8")))
    used: dict[str, set[str]] = {}
    for path in _frontend_sources():
        text = path.read_text(encoding="utf-8")
        declared.update(re.findall(r"(--[a-zA-Z0-9-]+)\s*:", text))
        # React inline style objects declare as ``"--name": value`` or
        # ``["--name" as string]: value``.
        declared.update(re.findall(
            r"[\"'](--[a-zA-Z0-9-]+)[\"'](?:\s+as\s+\w+)?\]?\s*:", text))
        # ``var(--db-${name})`` builds a name at runtime: not checkable.
        for name in re.findall(r"var\((--[a-zA-Z0-9-]*[a-zA-Z0-9])(?![-$\w])", text):
            used.setdefault(name, set()).add(str(path.relative_to(REPO_ROOT)))
    missing = {
        name: files for name, files in used.items()
        if name not in declared and not name.startswith("--radix-")
    }
    assert not missing, f"Undeclared CSS variables: {missing}"


# Colour tokens that are the same in both themes on purpose.
_THEME_FIXED_TOKENS = {
    "--db-brand", "--db-brand-ink", "--db-brand-glow",  # logo badge
    "--db-on-negative",                                  # white on red
    # The referral share card + crown: one gold-on-navy sub-theme.
    "--db-referral-gold", "--db-referral-gold-deep", "--db-referral-navy",
    "--db-referral-navy-deep", "--db-referral-border", "--db-referral-text",
    # Paper: printed receipts and paystubs are ink on white.
    "--db-paper", "--db-paper-ink", "--db-paper-text", "--db-paper-muted",
    "--db-paper-faint", "--db-paper-rule", "--db-paper-rule-soft",
}


def _block(css: str, selector: str) -> str:
    """Concatenate the bodies of every top-level ``selector { … }``."""
    out = []
    for m in re.finditer(re.escape(selector) + r"\s*\{", css):
        depth, i = 1, m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(css[i], 0)
            i += 1
        out.append(css[m.end():i - 1])
    return "\n".join(out)


def _decls(body: str) -> dict[str, str]:
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.S)
    return {k: v.strip() for k, v in
            re.findall(r"(--db-[a-z0-9-]+)\s*:\s*([^;]+);", body)}


def test_every_colour_token_has_a_light_value():
    """A token whose dark value is a colour literal must be redefined
    for light, or be listed as theme-fixed above. Tokens built from
    other tokens (``var(--db-gray-3)``) follow on their own."""
    css = TOKENS_CSS_PATH.read_text(encoding="utf-8")
    root = _decls(_block(css, ":root"))
    light = _decls(_block(css, '[data-theme="light"]'))
    needs_light = {
        name for name, value in root.items()
        if _COLOUR_RE.search(value) or re.fullmatch(r"\d+,\s*\d+,\s*\d+", value)
    }
    missing = sorted(needs_light - set(light) - _THEME_FIXED_TOKENS)
    assert not missing, (
        "Colour tokens with no [data-theme=\"light\"] value (add one, or "
        "list the token in _THEME_FIXED_TOKENS with a reason): "
        + ", ".join(missing)
    )
    stale = sorted(_THEME_FIXED_TOKENS & set(light))
    assert not stale, f"Theme-fixed tokens overridden for light: {stale}"


def test_theme_chrome_colours_match_tokens():
    css = TOKENS_CSS_PATH.read_text(encoding="utf-8")
    dark_bg = _decls(_block(css, ":root"))["--db-bg"]
    light_bg = _decls(_block(css, '[data-theme="light"]'))["--db-bg"]
    theme_ts = (FRONTEND_SRC / "lib" / "theme.ts").read_text(encoding="utf-8")
    assert f'dark: "{dark_bg}"' in theme_ts
    assert f'light: "{light_bg}"' in theme_ts
    index_html = (REPO_ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert f'name="theme-color" content="{dark_bg}"' in index_html
    assert f'"content", "{light_bg}"' in index_html


def test_every_static_stylesheet_is_linked():
    """static/shell.css styled the trial countdown chip but no page
    linked it, so the chip shipped as a bare blue browser link. A
    stylesheet under static/ must be linked by the SPA shell or a
    server template; otherwise its rules belong in the SPA's CSS."""
    pages = [REPO_ROOT / "frontend" / "index.html",
             *sorted((REPO_ROOT / "templates").rglob("*.html"))]
    linked = "\n".join(p.read_text(encoding="utf-8") for p in pages)
    orphans = [
        css.name for css in sorted((REPO_ROOT / "static").glob("*.css"))
        if f"/static/{css.name}" not in linked
    ]
    assert not orphans, f"Stylesheets no page links: {orphans}"

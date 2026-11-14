"""SPA-2 — Render build pipeline.

`scripts/build.sh` is what `render.yaml` invokes to produce a
deployable bundle: it installs Python deps, drops a Node binary
into the active Python prefix via `nodeenv`, then runs `npm ci +
npm run build` to emit `frontend/dist/`.

A full execution touches the network (downloads Node + npm deps)
so it's not a good fit for CI. These tests pin the contract that
the build script is wired up correctly:

  • scripts/build.sh exists, is executable, and references
    nodeenv (so deploy doesn't silently regress to Python-only)
  • render.yaml's buildCommand actually invokes scripts/build.sh
    (a developer who runs `pip install -r requirements.txt` by
    hand would skip the SPA otherwise)
  • Node version pinned in build.sh matches package.json's
    engines.node minimum (so dev + Render agree)
  • frontend/package.json declares engines.node >= 22.12 (Vite 8
    requires it)
"""
import json
import os
import re
import stat
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_SH  = REPO_ROOT / "scripts" / "build.sh"
RENDER    = REPO_ROOT / "render.yaml"
PKG_JSON  = REPO_ROOT / "frontend" / "package.json"


def test_build_sh_exists_and_executable():
    assert BUILD_SH.exists(), f"missing {BUILD_SH}"
    mode = BUILD_SH.stat().st_mode
    assert mode & stat.S_IXUSR, (
        f"{BUILD_SH} must be executable (chmod +x)"
    )


def test_build_sh_references_nodeenv():
    """`nodeenv` is the Python-side hook that drops Node onto PATH
    inside Render's Python service. If a refactor strips it, prod
    builds fall back to "Node not found" and the SPA stops shipping."""
    body = BUILD_SH.read_text()
    assert "nodeenv" in body, (
        "scripts/build.sh must invoke nodeenv to install Node on Render"
    )
    assert "npm ci" in body, (
        "scripts/build.sh must use `npm ci` (deterministic from "
        "package-lock) — `npm install` would let the lock drift"
    )
    assert "npm run build" in body


def test_build_sh_node_version_satisfies_engines():
    """Pinned Node version in build.sh must satisfy
    `engines.node` in package.json. Otherwise prod builds with a
    Node that Vite refuses to run on."""
    body = BUILD_SH.read_text()
    m = re.search(r'NODE_VERSION="([0-9.]+)"', body)
    assert m, "scripts/build.sh must set NODE_VERSION='X.Y.Z'"
    node_version = tuple(int(p) for p in m.group(1).split("."))

    pkg = json.loads(PKG_JSON.read_text())
    engines = pkg.get("engines", {}).get("node", "")
    em = re.search(r"(\d+)\.(\d+)\.(\d+)", engines)
    assert em, f"frontend/package.json engines.node missing: {engines!r}"
    min_engine = (int(em.group(1)), int(em.group(2)), int(em.group(3)))

    assert node_version >= min_engine, (
        f"build.sh pins Node {node_version} but package.json "
        f"requires >= {min_engine}"
    )


def test_render_buildcommand_runs_build_sh():
    """render.yaml's buildCommand has to actually invoke our
    script — a refactor back to `pip install -r requirements.txt`
    would silently drop the SPA from prod."""
    body = RENDER.read_text()
    # Match `buildCommand: ...build.sh` allowing `bash ` prefix
    # and `./` or `scripts/` paths.
    m = re.search(r"buildCommand:\s*(.+)", body)
    assert m, "render.yaml: no buildCommand line"
    cmd = m.group(1).strip()
    assert "scripts/build.sh" in cmd, (
        f"render.yaml buildCommand must invoke scripts/build.sh; "
        f"got {cmd!r}"
    )


def test_pkg_json_pins_engines_node_22_12_or_newer():
    pkg = json.loads(PKG_JSON.read_text())
    engines = pkg.get("engines", {}).get("node", "")
    em = re.search(r"(\d+)\.(\d+)", engines)
    assert em, f"engines.node must be set; got {engines!r}"
    major, minor = int(em.group(1)), int(em.group(2))
    assert (major, minor) >= (22, 12), (
        f"Vite 8 needs Node 22.12+; engines.node is {engines!r}"
    )


# ── Gunicorn worker recycling (memory) ───────────────────────────
# Render restarted the web service three times in Nov 2026 for going
# over its memory limit. gunicorn.conf.py makes each worker retire
# after a set number of requests so memory never creeps. Gunicorn
# loads ./gunicorn.conf.py by itself, which is why the setting lives
# there and not only in the start command: the live start command is
# the one in the Render dashboard, which a render.yaml edit may not
# reach.

GUNICORN_CONF = REPO_ROOT / "gunicorn.conf.py"


def _load_gunicorn_conf(monkeypatch, **env):
    import runpy
    for key in ("GUNICORN_MAX_REQUESTS", "GUNICORN_MAX_REQUESTS_JITTER"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return runpy.run_path(str(GUNICORN_CONF))


def test_gunicorn_conf_recycles_workers_by_default(monkeypatch):
    conf = _load_gunicorn_conf(monkeypatch)
    assert conf["max_requests"] == 1000
    assert conf["max_requests_jitter"] == 200


def test_gunicorn_conf_env_override(monkeypatch):
    conf = _load_gunicorn_conf(
        monkeypatch,
        GUNICORN_MAX_REQUESTS="500", GUNICORN_MAX_REQUESTS_JITTER="50",
    )
    assert conf["max_requests"] == 500
    assert conf["max_requests_jitter"] == 50


def test_gunicorn_conf_zero_turns_recycling_off(monkeypatch):
    conf = _load_gunicorn_conf(monkeypatch, GUNICORN_MAX_REQUESTS="0")
    assert conf["max_requests"] == 0


@pytest.mark.parametrize("bad,expected", [
    ("lots", 1000), ("1e3", 1000), ("  ", 1000), ("-5", 0),
])
def test_gunicorn_conf_bad_env_never_breaks_boot(monkeypatch, bad, expected):
    """A typo in the dashboard must not stop the service from
    starting: junk falls back to the default, a negative to 0."""
    conf = _load_gunicorn_conf(monkeypatch, GUNICORN_MAX_REQUESTS=bad)
    assert conf["max_requests"] == expected


def test_gunicorn_conf_is_a_valid_gunicorn_config(monkeypatch):
    """Gunicorn itself accepts the file and ends up with the values."""
    from gunicorn.app.base import Application

    class _App(Application):
        def init(self, parser, opts, args):  # pragma: no cover - unused
            return None

        def load(self):  # pragma: no cover - never served
            return None

    for key in ("GUNICORN_MAX_REQUESTS", "GUNICORN_MAX_REQUESTS_JITTER"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("sys.argv", ["gunicorn", "-c", str(GUNICORN_CONF), "x:y"])
    app = _App()
    assert app.cfg.max_requests == 1000
    assert app.cfg.max_requests_jitter == 200


def test_start_commands_do_not_override_recycling():
    """A --max-requests flag would beat gunicorn.conf.py; keep the
    numbers in one place. Both start commands still serve asgi_app."""
    for path in (RENDER, REPO_ROOT / "Dockerfile"):
        body = path.read_text()
        assert "gunicorn asgi:asgi_app" in body
        assert "--max-requests" not in body, path.name
        assert "--config" not in body and " -c " not in body, path.name

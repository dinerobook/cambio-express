"""DineroBook site agent — Gilbarco journal watcher.

Watches the folder where Gilbarco Passport writes its NAXML
files — the per-event journal (PJR*.xml) and the period movement
reports (FGM / ISM / MCM / MSM / TLM / TPM) — and pushes each new
file to the DineroBook API the moment it lands. Deliberately dumb
by design: no parsing, no XML knowledge — the server does all of
that, so this script almost never needs an update.

Python 3.9+ standard library only — no pip installs at the site.

    python dinerobook_agent.py --config agent.ini

Config (agent.ini):

    [agent]
    api_url    = https://dinerobook.com
    agent_key  = pak_...            ; issued in DineroBook, shown once
    watch_dir  = C:\\Passport\\XMLGateway\\BOOutbox
    pattern    = PJR*.xml FGM*.xml ISM*.xml MCM*.xml MSM*.xml TLM*.xml TPM*.xml
    poll_seconds = 5

``pattern`` is one or more filename patterns separated by spaces or
commas; a file matching any of them is sent. Leave it out to get
the default above.

State: a plain text file (uploaded.txt next to this script) lists
filenames already accepted by the server, so restarts never
re-upload (the server is idempotent anyway — this just saves
bandwidth). Delete the file to force a full re-send.

Run it as a Windows service via Task Scheduler ("At startup",
restart on failure) or NSSM. See agent/README.md.
"""
from __future__ import annotations

import argparse
import base64
import configparser
import fnmatch
import json
import logging
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

log = logging.getLogger("dinerobook-agent")

UPLOAD_PATH = "/api/v2/posimport/agent/upload"
# The journal plus every movement report family Passport writes.
DEFAULT_PATTERN = (
    "PJR*.xml FGM*.xml ISM*.xml MCM*.xml MSM*.xml TLM*.xml TPM*.xml"
)
# Files can still be mid-write when first seen — require the size
# to hold still for one poll before uploading.
MAX_FILE_BYTES = 4 * 1024 * 1024
RETRY_BACKOFF_SECONDS = (5, 15, 60, 300)
# Wait after the server refuses the key (401) or the store (402: the
# subscription has lapsed or the store is frozen; 403: the store has
# been disabled). Nothing a quick retry can fix, so back off; refused
# files stay unsent and go up once the store is open again.
REFUSED_WAIT_SECONDS = 300


def _server_detail(exc: urllib.error.HTTPError) -> str:
    """The server's ``detail`` message from an error answer, or ""."""
    try:
        return str(json.loads(exc.read().decode()).get("detail") or "")
    except Exception:            # noqa: BLE001 — best effort, for the log
        return ""


def load_config(path: str) -> dict:
    parser = configparser.ConfigParser()
    if not parser.read(path):
        sys.exit(f"Config file not found: {path}")
    section = parser["agent"]
    return {
        "api_url": section.get("api_url", "").rstrip("/"),
        "agent_key": section.get("agent_key", ""),
        "watch_dir": section.get("watch_dir", ""),
        "patterns": parse_patterns(section.get("pattern", DEFAULT_PATTERN)),
        "poll_seconds": section.getint("poll_seconds", 5),
    }


def parse_patterns(raw: str) -> list[str]:
    """``"PJR*.xml, FGM*.xml MSM*.xml"`` → each pattern. An empty
    value falls back to the default rather than matching nothing."""
    patterns = [p for p in raw.replace(",", " ").split() if p]
    return patterns or DEFAULT_PATTERN.split()


def matches(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) for p in patterns)


class UploadedLedger:
    """Filenames the server has already accepted."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._names: set[str] = set()
        if path.exists():
            self._names = {
                line.strip()
                for line in path.read_text().splitlines()
                if line.strip()
            }

    def __contains__(self, name: str) -> bool:
        return name in self._names

    def add(self, name: str) -> None:
        self._names.add(name)
        with self._path.open("a") as f:
            f.write(name + "\n")


def upload(cfg: dict, path: Path) -> bool:
    """Push one file. True = server accepted (staged or known
    duplicate); False = retry later."""
    content = path.read_bytes()
    if len(content) > MAX_FILE_BYTES:
        log.warning("skipping %s: too large (%d bytes)", path.name, len(content))
        return True   # never going to succeed — don't retry forever
    body = json.dumps({
        "filename": path.name,
        "content_base64": base64.b64encode(content).decode(),
    }).encode()
    request = urllib.request.Request(
        cfg["api_url"] + UPLOAD_PATH,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Agent-Key": cfg["agent_key"],
            "User-Agent": "dinerobook-agent/1.0",
        },
        method="POST",
    )
    for delay in (0,) + RETRY_BACKOFF_SECONDS:
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=30) as resp:
                data = json.loads(resp.read().decode())
                if data.get("parse_error"):
                    log.warning(
                        "%s staged with parse error: %s",
                        path.name, data["parse_error"],
                    )
                elif data.get("duplicate"):
                    log.info("%s already on server", path.name)
                else:
                    log.info(
                        "%s uploaded (business day %s)",
                        path.name, data.get("business_date"),
                    )
                return True
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                log.error("agent key rejected — fix agent.ini and restart")
                time.sleep(REFUSED_WAIT_SECONDS)
                return False
            if exc.code in (402, 403):
                log.error(
                    "server refused uploads for this store (HTTP %s: %s) "
                    "— files stay here and upload once the store is open "
                    "again",
                    exc.code, _server_detail(exc) or "no detail",
                )
                time.sleep(REFUSED_WAIT_SECONDS)
                return False
            if exc.code == 422:
                log.warning("%s rejected by server (422) — skipping", path.name)
                return True
            log.warning("%s: HTTP %s — will retry", path.name, exc.code)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            log.warning("%s: %s — will retry", path.name, exc)
    return False


def watch(cfg: dict) -> None:
    watch_dir = Path(cfg["watch_dir"])
    if not watch_dir.is_dir():
        sys.exit(f"Watch directory not found: {watch_dir}")
    ledger = UploadedLedger(Path(__file__).with_name("uploaded.txt"))
    log.info(
        "watching %s for %s (every %ss)",
        watch_dir, " ".join(cfg["patterns"]), cfg["poll_seconds"],
    )
    pending_sizes: dict[str, int] = {}
    while True:
        try:
            for path in sorted(watch_dir.iterdir()):
                name = path.name
                if not matches(name, cfg["patterns"]):
                    continue
                if name in ledger:
                    continue
                size = path.stat().st_size
                # Wait until the size holds still across two polls —
                # Passport may still be writing the file.
                if pending_sizes.get(name) != size:
                    pending_sizes[name] = size
                    continue
                if upload(cfg, path):
                    ledger.add(name)
                    pending_sizes.pop(name, None)
        except Exception:            # noqa: BLE001 — a watcher must not die
            log.exception("watch loop error — continuing")
        time.sleep(cfg["poll_seconds"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="agent.ini")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    cfg = load_config(args.config)
    for field in ("api_url", "agent_key", "watch_dir"):
        if not cfg[field]:
            sys.exit(f"agent.ini is missing [agent] {field}")
    watch(cfg)


if __name__ == "__main__":
    main()

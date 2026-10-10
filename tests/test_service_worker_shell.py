"""The service worker precaches a fixed list of shell files.

``cache.addAll`` rejects if any one entry 404s, and the install
handler swallows that rejection — so a single stale entry (the Flask-
era ``app.css`` / ``content.css`` were left in the list after the
files were deleted) silently leaves the cache empty and the offline
page never shows. Pin that every entry resolves.
"""
import os
import re

_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))


def _shell_entries():
    with open(os.path.join(_ROOT, "static", "sw.js"), encoding="utf-8") as f:
        src = f.read()
    block = re.search(r"const SHELL = \[(.*?)\];", src, re.S).group(1)
    return re.findall(r"'([^']+)'", block)


def test_every_static_shell_entry_exists_on_disk():
    entries = [e for e in _shell_entries() if e.startswith("/static/")]
    assert entries, "SHELL list not found in static/sw.js"
    missing = [
        e for e in entries
        if not os.path.isfile(os.path.join(_ROOT, e.lstrip("/")))
    ]
    assert missing == []


def test_offline_page_is_precached_and_served(client):
    assert "/offline" in _shell_entries()
    assert client.get("/offline").status_code == 200

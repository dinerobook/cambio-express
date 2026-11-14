"""Gunicorn settings that hold however the service is started.

Gunicorn reads ``./gunicorn.conf.py`` by itself, so these apply to the
start command in ``render.yaml``, to the one typed into the Render
dashboard and to the ``Dockerfile`` alike. Flags on the command line
still win: worker count, bind address and timeout stay there.

Worker recycling. A Python process never hands memory back to the
system once it has grown: each big request (a tax-export zip, a long
report) raises the worker's floor for good, and the instance was
restarted by Render three times in November 2026 for going over its
memory limit. Each worker now retires after ``max_requests`` requests
(plus up to ``max_requests_jitter`` more, so both workers never retire
together) and gunicorn starts a fresh one. The other worker serves
meanwhile, so nobody sees it.

``GUNICORN_MAX_REQUESTS`` / ``GUNICORN_MAX_REQUESTS_JITTER`` in the
service's environment change the numbers without a deploy; 0 turns
recycling off.
"""
import os


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        return default
    return max(value, 0)


max_requests = _int_env("GUNICORN_MAX_REQUESTS", 1000)
max_requests_jitter = _int_env("GUNICORN_MAX_REQUESTS_JITTER", 200)

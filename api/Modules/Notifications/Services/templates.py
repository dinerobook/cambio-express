"""Email-template renderer (standalone Jinja2).

Renders the HTML email templates in ``templates/emails/`` via a
Jinja2 ``Environment`` that has zero dependency on Flask. Used by
the trial-reminder cron, the locked-day digest, the
announcement-broadcast CLI, and any future caller that needs to
mail a templated HTML body.

Why not Flask's ``render_template``: it requires a request context,
which forced cron + webhook callers to fabricate one with
``app.test_request_context("/")``. The standalone env is pure
str-in, str-out — works from any caller, with no Flask boot cost
and no fake request context.
"""
from __future__ import annotations

import os

from typing import Any

from jinja2 import Environment, FileSystemLoader, pass_context, select_autoescape
from jinja2.runtime import Context
from markupsafe import Markup

from api.Modules.Notifications.Services.email_text import (
    bold, email_t, email_t_html,
)


_TEMPLATES_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "templates"),
)

_env = Environment(
    loader=FileSystemLoader(_TEMPLATES_DIR),
    autoescape=select_autoescape(["html", "xml"]),
)


# The words of a template, in the ``lang`` it is rendered with
# (email_text.py). Globals that read ``lang`` from the render context,
# so a macro imported ``with context`` speaks the reader's language
# too; anything rendered without one (an import that only fetches a
# macro) reads English.
@pass_context
def _t(ctx: Context, key: str, **vars: Any) -> str:
    return email_t(str(ctx.get("lang") or "en"), key, **vars)


@pass_context
def _th(ctx: Context, key: str, **vars: Any) -> Markup:
    return email_t_html(str(ctx.get("lang") or "en"), key, **vars)


_env.globals.update(t=_t, th=_th, bold=bold)


def render_email_template(
    template_name: str, /, *, lang: str = "en", **ctx: object,
) -> str:
    """Render an email template by path (e.g.
    ``"emails/trial_reminder.html"``). The Jinja2 env is rooted at
    the repo's ``templates/`` directory so the relative
    ``{% extends "emails/_base.html" %}`` declarations in the email
    templates keep working.

    ``lang`` is the reader's email language (``email_language(user)``);
    the template reads its words through ``t(key)`` / ``th(key)``.

    ``template_name`` is positional-only so callers can pass
    ``name=u.full_name`` in ``**ctx`` without a parameter-collision
    TypeError. (Legacy callers do exactly that — the previous
    signature ``(name: str, **ctx)`` was a latent bug.)
    """
    from api.Core.Brand import get_brand_name
    tmpl = _env.get_template(template_name)
    # brand_name is available in EVERY email template (the _base
    # chrome uses it); explicit ctx wins if a caller passes one.
    # ``lang`` picks the words ``t`` / ``th`` give the template.
    return tmpl.render(**{"brand_name": get_brand_name(), **ctx, "lang": lang})


__all__ = ["render_email_template"]

"""Emails in the reader's language (email_text.py, UI-STANDARDS §10).

Pinned:
* every English text has a Spanish twin with the same placeholders,
  and the Spanish is really translated;
* a translated template carries no typed English: its words all come
  through ``t()`` / ``th()``;
* rendered in Spanish, a template shows none of the English texts;
* only a person who picked Spanish gets it; NULL / English / unknown
  get English, exactly as before;
* a value put into a sentence with markup is escaped;
* each translated email (password reset, new sign-in, trial reminder)
  goes out in the person's language: subject, plain body, HTML, push.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from api.Modules.Notifications.Services.email_text import (
    EN, ES, email_date, email_datetime, email_language, email_t,
    email_t_html, email_time, email_tn, placeholders,
)
from api.Modules.Notifications.Services.templates import render_email_template


TEMPLATES = Path(__file__).resolve().parents[3] / "templates" / "emails"

# Templates whose every word comes from email_text.py. A template joins
# this list when it is translated; it never leaves it.
TRANSLATED = {
    "_base.html": {},
    "password_reset.html": {"reset_url": "https://x.test/r?token=abc"},
    "trial_reminder.html": {
        "store_name": "Tienda Uno", "trial_end_date": "9 de mayo de 2026",
        "days": 3, "subscribe_url": "https://x.test/subscribe",
        "notifications_url": "https://x.test/n",
    },
    "daily_summary.html": {
        "store_name": "Tienda Uno", "date_human": "5 de noviembre de 2026",
        "transfer_count": 4, "send_volume": "$800.00", "receipts": "$900.00",
        "disbursements": "$100.00", "over_short": "$0.00", "net": "$800.00",
        "net_negative": False, "view_url": "https://x.test/v",
        "notifications_url": "https://x.test/n",
    },
    "locked_day_digest.html": {
        "store_name": "Tienda Uno", "date_human": "5 de noviembre de 2026",
        "locked_by": "Rosa", "receipts": "$900.00", "disbursements": "$100.00",
        "over_short": "$0.00", "net": "$800.00", "net_negative": False,
        "view_url": "https://x.test/v", "notifications_url": "https://x.test/n",
    },
    "ticket_update.html": {
        "heading": "Novedades del ticket", "event_line": "Soporte respondió a su ticket",
        "ticket_id": 12, "subject": "La impresora", "store_name": "",
        "status": "En curso", "priority": "P2", "detail": "Ya quedó.",
        "view_url": "https://x.test/v", "cta_label": "Abrir la conversación",
        "notifications_url": "https://x.test/n",
    },
    "announcement.html": {
        "subject": "Mantenimiento", "message": "Mantenimiento el sábado.",
        "level": "warning", "app_url": "https://x.test",
        "notifications_url": "https://x.test/n",
    },
    "new_sign_in.html": {
        "username": "ana", "device": "Safari en iPhone", "ip": "198.51.100.23",
        "when": "22 oct 2026, 1:05 a. m. (UTC)",
        "devices_url": "https://x.test/d", "notifications_url": "https://x.test/n",
    },
}

# Text a template may show as typed: the site's own address.
_TYPED_OK = {"dinerobook.com"}


# ── The catalog ──────────────────────────────────────────────


def test_every_english_text_has_a_spanish_twin():
    assert sorted(EN) == sorted(ES)


@pytest.mark.parametrize("key", sorted(EN))
def test_placeholders_match(key):
    assert placeholders(EN[key]) == placeholders(ES[key]), key


def test_spanish_is_really_translated():
    assert [k for k in EN if EN[k] == ES[k]] == []


def test_spanish_never_calls_anyone_super_admin():
    assert [v for v in ES.values() if re.search(r"super\s*admin", v, re.I)] == []


# ── Who gets Spanish ─────────────────────────────────────────


@pytest.mark.parametrize("language,expected", [
    (None, "en"), ("", "en"), ("en", "en"), ("es", "es"), ("fr", "en"),
])
def test_only_a_person_who_picked_spanish_gets_it(language, expected):
    assert email_language(SimpleNamespace(language=language)) == expected
    assert email_language(object()) == "en"


def test_unknown_language_reads_english():
    assert email_t("fr", "reset.subject") == EN["reset.subject"]


# ── Dates ────────────────────────────────────────────────────


def test_dates_in_each_language():
    d = datetime(2026, 5, 9, 13, 5)
    assert email_date(d, "en") == "May 09, 2026"
    assert email_date(d, "es") == "9 de mayo de 2026"
    assert email_datetime(d, "en", "America/Chicago") == \
        "May 9, 2026 at 1:05 PM (America/Chicago)"
    assert email_datetime(d, "es", "America/Chicago") == \
        "9 may 2026, 1:05 p. m. (America/Chicago)"
    midnight = datetime(2026, 1, 2, 0, 7)
    assert email_datetime(midnight, "es", "UTC") == "2 ene 2026, 12:07 a. m. (UTC)"


# ── Markup sentences escape their values ─────────────────────


def test_markup_sentence_escapes_values():
    html = str(email_t_html("es", "trial.lead", store_name="<b>x</b>", trial_end_date="d"))
    assert "&lt;b&gt;x&lt;/b&gt;" in html
    assert "<b>" not in html


def test_rendered_template_escapes_store_name():
    html = render_email_template(
        "emails/trial_reminder.html", lang="es",
        **{**TRANSLATED["trial_reminder.html"], "store_name": "<script>x</script>"},
    )
    assert "<script>x" not in html
    assert "&lt;script&gt;x&lt;/script&gt;" in html


# ── Templates ────────────────────────────────────────────────


def _typed_text(source: str) -> list[str]:
    """Words a template types itself, outside Jinja and HTML."""
    s = re.sub(r"\{#.*?#\}", " ", source, flags=re.S)
    s = re.sub(r"\{%.*?%\}", " ", s, flags=re.S)
    s = re.sub(r"\{\{.*?\}\}", " ", s, flags=re.S)
    s = re.sub(r"<!--.*?-->", " ", s, flags=re.S)
    s = re.sub(r"<[^>]*>", " ", s, flags=re.S)
    s = re.sub(r"&[a-z]+;|&#\d+;", " ", s)
    return [w for w in s.split() if re.search(r"[A-Za-z]", w) and w not in _TYPED_OK]


@pytest.mark.parametrize("name", sorted(TRANSLATED))
def test_translated_template_types_no_english(name):
    assert _typed_text((TEMPLATES / name).read_text()) == []


def _english_fragments() -> list[str]:
    """Each English text's fixed parts (split at placeholders and
    lines), long enough to mean something."""
    out: set[str] = set()
    for key, text in EN.items():
        if ES[key] == text:
            continue
        for part in re.split(r"\{\w+\}|\n", text):
            part = part.strip(" ,.:;—-\"()")
            if len(part) >= 6 and part not in ES[key]:
                out.add(part)
    return sorted(out)


def _visible(html: str) -> str:
    s = re.sub(r"<[^>]*>", " ", html)
    return re.sub(r"\s+", " ", s)


@pytest.mark.parametrize("name", sorted(n for n in TRANSLATED if n != "_base.html"))
def test_spanish_render_shows_no_english(name):
    html = render_email_template(
        f"emails/{name}", lang="es", name="Ana", year=2026,
        base_url="https://x.test", preheader="", **TRANSLATED[name],
    )
    visible = _visible(html)
    leftovers = [
        f for f in _english_fragments()
        if re.search(rf"(?<![\w]){re.escape(f)}(?![\w])", visible)
    ]
    assert leftovers == []
    assert 'lang="es"' in html


@pytest.mark.parametrize("name", sorted(n for n in TRANSLATED if n != "_base.html"))
def test_english_render_is_the_default(name):
    html = render_email_template(
        f"emails/{name}", name="Ana", year=2026, base_url="https://x.test",
        preheader="", **TRANSLATED[name],
    )
    assert 'lang="en"' in html
    if name != "announcement.html":
        assert "Hi Ana," in html
    assert "You're receiving this because your DineroBook account" in _visible(html)


def test_greeting_without_a_name():
    en = render_email_template("emails/password_reset.html", reset_url="u")
    es = render_email_template("emails/password_reset.html", lang="es", reset_url="u")
    assert "Hi," in en
    assert "Hola:" in es


# ── Each email in the person's language ──────────────────────


def _person(store_id: int, *, language: str | None, **extra: object) -> int:
    from tests._app import db, db_session
    from api.Modules.Tenancy.Models import User
    import uuid
    with db_session():
        u = User(
            username=f"mail-{uuid.uuid4().hex[:8]}@test.com", password_hash="x",
            role="admin", full_name="Ana", email=f"a{uuid.uuid4().hex[:6]}@test.com",
            store_id=store_id, is_active=True, language=language, **extra,
        )
        db.session.add(u)
        db.session.commit()
        return int(u.id)


@pytest.fixture
def mails(monkeypatch):
    sent: list[dict[str, object]] = []
    from api.Modules.Notifications.Services import smtp as smtp_mod
    monkeypatch.setattr(
        smtp_mod, "send_email",
        lambda db_, to, subject, body, html=None: sent.append(
            {"to": to, "subject": subject, "body": body, "html": html},
        ) or True,
    )
    return sent


@pytest.mark.parametrize("language,subject,phrase", [
    (None, "Reset your DineroBook password", "Someone (hopefully you)"),
    ("en", "Reset your DineroBook password", "Someone (hopefully you)"),
    ("es", "Restablezca su contraseña de DineroBook", "Alguien (esperamos que usted)"),
])
def test_password_reset_in_the_persons_language(test_store_id, mails, language, subject, phrase):
    from api.Modules.Auth.Controllers import send_password_reset_email
    uid = _person(test_store_id, language=language)
    send_password_reset_email(uid, "raw-token-123")
    assert len(mails) == 1
    mail = mails[0]
    assert mail["subject"] == subject
    assert phrase in str(mail["body"])
    assert "/app/reset-password?token=raw-token-123" in str(mail["body"])
    assert mail["html"] and phrase in str(mail["html"])


def test_new_sign_in_alert_in_spanish(test_store_id, mails, monkeypatch):
    from tests._app import db, db_session
    from api.Modules.Auth.Models import RefreshToken
    from api.Modules.Notifications.Services import new_sign_in
    from api.Modules.Notifications.Services import push as push_mod
    from api.Core.Clock import utc_now
    pushes: list[dict[str, object]] = []
    monkeypatch.setattr(
        push_mod, "send_push",
        lambda db_, user_id, title, body="", url="/", tag=None: pushes.append(
            {"title": title, "body": body},
        ) or 1,
    )
    uid = _person(
        test_store_id, language="es",
        notify_new_sign_in=True, notify_new_sign_in_push=True,
    )
    chrome = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 Version/17 Safari/604.1"
    now = utc_now()
    with db_session():
        for sid, ua, when in (("s-old", chrome, now - timedelta(days=2)), ("s-new", iphone, now)):
            db.session.add(RefreshToken(
                user_id=uid, session_id=sid, jti=f"{sid}-{uid}",
                user_agent=ua, ip_address=None,
                created_at=when, expires_at=now + timedelta(days=7),
            ))
        db.session.commit()
    assert new_sign_in.send_new_sign_in_alert(uid, "s-new") == 1
    mail = mails[0]
    assert mail["subject"] == "Nuevo inicio de sesión en su cuenta de DineroBook"
    body = str(mail["body"])
    assert "Safari en iPhone" in body
    assert "desconocida" in body  # no address recorded
    assert "Hola, Ana:" in body
    assert "Safari en iPhone" in str(mail["html"])
    assert pushes == [{
        "title": "Nuevo inicio de sesión en su cuenta",
        "body": "Safari en iPhone · desconocida. ¿No fue usted? Cierre esa sesión.",
    }]


def test_describe_user_agent_compares_in_english():
    """The new-device check compares English labels whatever the
    reader's language, so switching to Spanish never re-alerts."""
    ua = "Mozilla/5.0 (iPhone) Safari/604.1"
    assert new_sign_in_label(ua, "en") == "Safari on iPhone"
    assert new_sign_in_label(ua, "es") == "Safari en iPhone"
    assert new_sign_in_label(None, "es") == "Dispositivo desconocido"
    assert new_sign_in_label("weird-agent", "es") == "Navegador"


def new_sign_in_label(ua: str | None, lang: str) -> str:
    from api.Modules.Notifications.Services.new_sign_in import describe_user_agent
    return describe_user_agent(ua, lang)


def test_trial_reminder_in_each_persons_language(monkeypatch):
    from tests._app import db, db_session
    from api.Core.Clock import utc_now
    from api.Modules.Notifications.Services.trial_reminders import run
    from api.Modules.Tenancy.Models import Store, User
    sent: list[tuple[str, str, str, str]] = []
    monkeypatch.setattr(
        "api.Modules.Notifications.Services.trial_reminders.send_email",
        lambda session, to, subject, body, html: sent.append(
            (to, subject, body, html),
        ) or True,
    )
    with db_session():
        db.session.query(Store).delete()
        db.session.query(User).delete()
        db.session.commit()
        now = utc_now()
        ends = now + timedelta(days=2, hours=1)
        s = Store(
            name="Tienda Uno", slug="lang-trial", plan="trial",
            email="t@example.com", trial_ends_at=ends,
        )
        db.session.add(s); db.session.flush()
        for addr, language in (("en@test.com", None), ("es@test.com", "es")):
            db.session.add(User(
                username=addr, password_hash="x", role="admin", full_name="Ana",
                email=addr, store_id=s.id, notify_trial_reminders=True,
                is_active=True, language=language,
            ))
        db.session.commit()
        count = run(db.session, now=now, base_url="https://x.test")
        assert count == 2
        by_to = {to: (subject, body, html) for to, subject, body, html in sent}
        assert by_to["en@test.com"][0] == "Your DineroBook trial ends in 2 days"
        assert ends.strftime("%B %d, %Y") in by_to["en@test.com"][1]
        subject, body, html = by_to["es@test.com"]
        assert subject == "Su prueba de DineroBook termina en 2 días"
        assert email_date(ends, "es") in body
        assert email_date(ends, "es").startswith(f"{ends.day} de ")
        assert "Suscribirse ahora" in html
        assert 'lang="es"' in html


# ── Part 2: digests, tickets, announcements, missed shifts ───


def test_counts_times_and_weekdays():
    from datetime import date, time
    assert email_tn("en", "shifts.push", 1) == "1 missed shift — tap to review."
    assert email_tn("en", "shifts.push", 3) == "3 missed shifts — tap to review."
    assert email_tn("es", "shifts.push", 1) == "1 turno no cumplido: toque para revisarlo."
    assert email_tn("es", "shifts.push", 0) == "0 turnos no cumplidos: toque para revisarlos."
    assert email_time(time(9, 0), "en") == "9:00 AM"
    assert email_time(time(0, 30), "es") == "12:30 a. m."
    assert email_time(time(17, 5), "es") == "5:05 p. m."
    thu = date(2026, 11, 5)
    assert email_date(thu, "en", english="%a %b %d, %Y", weekday=True) == "Thu Nov 05, 2026"
    assert email_date(thu, "es", weekday=True) == "jueves, 5 de noviembre de 2026"


@pytest.mark.parametrize("level,en_kind,es_kind", [
    ("warning", "Heads up", "Atención"), ("error", "Important", "Importante"),
    ("success", "Update", "Novedad"), ("info", "Announcement", "Aviso"),
    ("weird", "Announcement", "Aviso"),
])
def test_announcement_kicker_in_each_language(level, en_kind, es_kind):
    ctx = {**TRANSLATED["announcement.html"], "level": level}
    assert en_kind in render_email_template("emails/announcement.html", **ctx)
    assert es_kind in render_email_template("emails/announcement.html", lang="es", **ctx)


def test_announcement_message_goes_out_as_typed(monkeypatch):
    """The superadmin's own words are not translated; the subject
    falls back to the reader's generic line when the message is empty."""
    from api.Modules.Notifications.Services.broadcasts import derive_broadcast_subject
    assert derive_broadcast_subject("Hola a todos\nmás", "en") == "Hola a todos"
    assert derive_broadcast_subject("  ", "en") == "A message from DineroBook"
    assert derive_broadcast_subject("  ", "es") == "Un mensaje de DineroBook"


def test_ticket_status_and_detail_in_the_readers_language():
    from api.Modules.Notifications.Services.ticket_updates import (
        _detail_for, _status_label,
    )
    assert _status_label("es", "in_progress") == "En curso"
    assert _status_label("en", "in_progress") == "In progress"
    assert _status_label("es", "archived") == "archived"  # unknown → as stored
    assert _status_label("es", None) == "Abierto"
    assert _detail_for("es", "status_change", "Reopened") == "Reabierto"
    assert _detail_for("es", "status_change", "In progress") == "En curso"
    # A reply snippet is the person's own words.
    assert _detail_for("es", "staff_reply", "Resolved") == "Resolved"


def _store_with_people(*people: tuple[str, str | None], **user_extra: object) -> int:
    from tests._app import db, db_session
    from api.Modules.Tenancy.Models import Store, User
    import uuid
    with db_session():
        s = Store(name="Tienda Uno", slug=f"lang-{uuid.uuid4().hex[:8]}", plan="pro",
                  email="t@example.com")
        db.session.add(s); db.session.flush()
        for addr, language in people:
            db.session.add(User(
                username=addr, password_hash="x", role="admin", full_name="Ana",
                email=addr, store_id=s.id, is_active=True, language=language,
                **user_extra,
            ))
        db.session.commit()
        return int(s.id)


def test_ticket_update_to_user_in_spanish(mails, monkeypatch):
    import uuid
    from tests._app import db, db_session
    from api.Modules.Support.Models import SupportTicket
    from api.Modules.Tenancy.Models import User
    from api.Modules.Notifications.Services import push as push_mod
    from api.Modules.Notifications.Services.ticket_updates import send_ticket_update_to_user
    pushes: list[dict[str, object]] = []
    monkeypatch.setattr(
        push_mod, "send_push",
        lambda db_, user_id, title, body="", url="/", tag=None: pushes.append(
            {"title": title, "body": body},
        ) or 1,
    )
    addr = f"t{uuid.uuid4().hex[:6]}@test.com"
    sid = _store_with_people((addr, "es"), notify_ticket_updates=True)
    with db_session():
        uid = db.session.query(User).filter_by(username=addr).one().id
        t = SupportTicket(store_id=sid, user_id=uid, subject="La impresora",
                          submitted_by="Ana", body="No imprime", status="in_progress", priority="P2")
        db.session.add(t); db.session.commit()
        tid = int(t.id)
    assert send_ticket_update_to_user(tid, "status_change", "In progress") == 1
    mail = mails[0]
    assert mail["subject"] == "Novedades de su ticket de soporte: La impresora"
    assert "Cambió el estado de su ticket" in str(mail["body"])
    assert "En curso" in str(mail["body"])
    html = str(mail["html"])
    assert "En curso" in html and "Abrir la conversación" in html
    assert 'lang="es"' in html
    assert pushes and pushes[0]["body"] == "Cambió el estado de su ticket — En curso"


def test_missed_shift_digest_in_spanish():
    from datetime import date, time
    from types import SimpleNamespace as NS
    from unittest.mock import patch
    from api.Modules.Notifications.Services import missed_shifts
    shift = NS(store_employee_id=1, start_time=time(9, 0), end_time=time(17, 0))
    with patch.object(missed_shifts, "_employee_name", return_value="Rosa"):
        subject, body = missed_shifts._format_digest_body(
            None, store_name="Tienda Uno", on_date=date(2026, 11, 5),
            missed=[shift], lang="es",
        )
        en_subject, en_body = missed_shifts._format_digest_body(
            None, store_name="Tienda Uno", on_date=date(2026, 11, 5), missed=[shift, shift],
        )
    assert subject == "Tienda Uno — 1 turno no cumplido · jueves, 5 de noviembre de 2026"
    assert "Rosa — programado de 9:00 a. m. a 5:00 p. m." in body
    assert en_subject == "Tienda Uno — 2 missed shifts · Thu Nov 05, 2026"
    assert "Rosa — scheduled 9:00 AM to 5:00 PM" in en_body

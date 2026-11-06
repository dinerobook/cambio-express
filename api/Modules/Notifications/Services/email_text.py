"""The words of every email, in English and Spanish.

Spanish is per person (UI-STANDARDS §10): an email goes out in Spanish
only to someone whose ``User.language`` is ``"es"``. NULL (never
chosen), English or anything unknown gets English, exactly as before
Spanish existed. Spanish uses the formal "usted", like the app.

How a sender uses it:

* ``lang = email_language(user)`` once per recipient.
* ``email_t(lang, "reset.subject")`` for a subject, a plain-text body,
  a push or a preheader. ``{name}`` style placeholders are filled from
  the keyword arguments; the values are inserted as given.
* ``render_email_template(name, lang=lang, ...)`` hands the template
  ``t(key, **vars)`` (plain text, autoescaped by Jinja) and
  ``th(key, **vars)`` (for a sentence with markup in it: the catalog
  text is trusted, every value is HTML-escaped).
* ``email_date(d, lang)`` / ``email_datetime(dt, lang)`` for dates.

``tests/Modules/Notifications/test_email_text.py`` fails when a key is
missing its Spanish twin, the placeholders differ, or a translated
template still carries typed English.
"""
from __future__ import annotations

import string
from datetime import date, datetime, time
from typing import Any, Final

from markupsafe import Markup


LANGUAGES: Final = ("en", "es")


def email_language(user: Any) -> str:
    """The language one person's emails go out in: ``"es"`` only when
    they picked Spanish, English for everyone else."""
    return "es" if getattr(user, "language", None) == "es" else "en"


EN: Final[dict[str, str]] = {
    # ── Shared chrome (_base.html) ─────────────────────────────
    "base.footer": (
        "You're receiving this because your {brand} account is set to "
        "receive transactional notifications. Manage preferences on your "
        "{link}."
    ),
    "base.notificationsPage": "notifications page",
    "base.pasteLink": "Or paste this into your browser:",
    "base.hi": "Hi,",
    "base.hiName": "Hi {name},",

    # ── Password reset ─────────────────────────────────────────
    "reset.subject": "Reset your DineroBook password",
    "reset.preheader": "Reset your DineroBook password — link expires in 1 hour.",
    "reset.heading": "Reset your password",
    "reset.lead": (
        "Someone (hopefully you) asked to reset the password for your "
        "DineroBook account. Tap the button below within the next hour "
        "to set a new one."
    ),
    "reset.button": "Set new password",
    "reset.pasteLink": "If the button doesn't work, paste this link into your browser:",
    "reset.ignore": (
        "Didn't request this? You can safely ignore this email — your "
        "current password will keep working. The reset link expires in "
        "one hour."
    ),
    "reset.body": (
        "Hi,\n\n"
        "Someone (hopefully you) requested a password reset for your "
        "DineroBook account. Follow this link within the next hour to "
        "set a new password:\n\n"
        "  {reset_url}\n\n"
        "If you didn't request this you can safely ignore this email "
        "— your current password will keep working.\n"
    ),

    # ── New sign-in alert ──────────────────────────────────────
    "signIn.subject": "New sign-in to your DineroBook account",
    "signIn.title": "New sign-in to your account",
    "signIn.preheader": "{device} signed in to your account",
    "signIn.lead": "Your account was just signed in to from a device it hasn't used before.",
    "signIn.device": "Device",
    "signIn.address": "Address",
    "signIn.when": "When",
    "signIn.advice": (
        "If this was you, there is nothing to do. If it wasn't, sign "
        "that device out and change your password."
    ),
    "signIn.button": "Review my devices",
    "signIn.turnOff": "Don't want these alerts? Turn them off on your {link}.",
    "signIn.unknownIp": "unknown",
    "signIn.unknownDevice": "Unknown device",
    "signIn.browser": "Browser",
    "signIn.deviceOn": "{browser} on {platform}",
    "signIn.pushBody": "{device} · {ip}. Not you? Sign it out.",
    "signIn.body": (
        "Hi {name},\n"
        "\n"
        "Your DineroBook account ({username}) was just signed in to from a\n"
        "device it hasn't used before.\n"
        "\n"
        "    Device:  {device}\n"
        "    Address: {ip}\n"
        "    When:    {when}\n"
        "\n"
        "If this was you, there is nothing to do.\n"
        "\n"
        "If it wasn't, sign that device out and change your password:\n"
        "    {devices_url}\n"
        "\n"
        "You're getting this because new sign-in alerts are on. Turn them off\n"
        "on your notifications page:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Trial ending reminder ──────────────────────────────────
    "trial.subject": "Your DineroBook trial ends in {days} days",
    "trial.heading": "Your trial ends in {days} days",
    "trial.preheader": "Your DineroBook trial for {store_name} ends on {trial_end_date}.",
    "trial.lead": (
        "Just a heads up — the DineroBook trial for {store_name} ends on "
        "{trial_end_date}. To keep your books, reports, and transfer "
        "history, subscribe before then."
    ),
    "trial.button": "Subscribe now",
    "trial.noAction": (
        "No action required if you'd rather let the trial expire. We "
        "keep your data for 180 days after cancellation, so you can "
        "come back without losing history."
    ),
    "trial.turnOff": "Don't want trial reminders? Turn them off on your {link}.",
    "trial.body": (
        "Hi {name},\n"
        "\n"
        "Just a heads-up that your DineroBook trial for \"{store_name}\" ends on\n"
        "{trial_end_date}. That's {days} days from today.\n"
        "\n"
        "To keep your books, reports, and transfer history, subscribe before\n"
        "then:\n"
        "    {subscribe_url}\n"
        "\n"
        "No action is required if you'd rather let the trial expire; we keep\n"
        "your data for 180 days after cancellation so you can come back.\n"
        "\n"
        "Don't want trial reminders anymore? Turn them off on your\n"
        "notifications page:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),
    # ── Daily summary ──────────────────────────────────────────
    "daily.subject": "Daily summary — {store_name}, {date_human}",
    "daily.heading": "Daily summary",
    "daily.lead": "Here's yesterday's close-out for {store_name}.",
    "daily.figures": "{transfer_count} transfers · {send_volume} sent",
    "daily.pushBody": "{figures} · net {net}",
    "daily.transfers": "Transfers logged",
    "daily.volume": "Send volume",
    "daily.receipts": "Receipts",
    "daily.disbursements": "Disbursements",
    "daily.overShort": "Over / short",
    "daily.net": "Net position",
    "daily.button": "Open in DineroBook",
    "daily.quietDays": (
        "You only receive this digest on days that had at least one "
        "transfer or a saved daily-report row. Quiet days don't generate "
        "an email."
    ),
    "daily.turnOff": "Don't want daily-summary digests? Turn them off on your {link}.",
    "daily.body": (
        "Hi {name},\n"
        "\n"
        "Here's yesterday's close-out for \"{store_name}\" ({date_human}):\n"
        "\n"
        "  Transfers logged   {transfer_count}\n"
        "  Send volume        {send_volume}\n"
        "  Receipts           {receipts}\n"
        "  Disbursements      {disbursements}\n"
        "  Over / short       {over_short}\n"
        "  Net position       {net}\n"
        "\n"
        "Open the day in DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "You're getting this digest because you're listed as an owner or\n"
        "admin of {store_name}. Turn it off on your notifications page:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Locked-day digest ──────────────────────────────────────
    "locked.subject": "Daily book locked — {store_name}, {date_human}",
    "locked.heading": "Daily book locked",
    "locked.preheader": "Daily book locked for {store_name} on {date_human}. Net {net}.",
    "locked.lead": "The daily book for {store_name} on {date_human} was just locked by {locked_by}.",
    "locked.anAdmin": "an admin",
    "locked.pushBody": "Locked by {locked_by}. Net {net}.",
    "locked.readOnly": (
        "A locked day is read-only — the cashier can re-open it on the "
        "Daily Book screen if a number needs correcting. Each unlock + "
        "re-lock fires a fresh digest so you'll see corrections land."
    ),
    "locked.turnOff": "Don't want close-out digests? Turn them off on your {link}.",
    "locked.body": (
        "Hi {name},\n"
        "\n"
        "The daily book for \"{store_name}\" on {date_human} was just locked\n"
        "by {locked_by}.\n"
        "\n"
        "  Receipts          {receipts}\n"
        "  Disbursements     {disbursements}\n"
        "  Over / short      {over_short}\n"
        "  Net position      {net}\n"
        "\n"
        "Open the day in DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "You're getting this digest because you're listed as an owner or\n"
        "admin of {store_name}. Turn it off on your notifications page:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Support ticket updates ─────────────────────────────────
    "ticket.userSubject": "Update on your support ticket: {subject}",
    "ticket.platformSubject": "Ticket #{ticket_id} {store_name}: {event_label}",
    "ticket.staffReply": "Support replied to your ticket",
    "ticket.statusChange": "Your ticket's status changed",
    "ticket.updated": "Your ticket was updated",
    "ticket.created": "New ticket",
    "ticket.userReply": "New reply",
    "ticket.reopenedEvent": "Ticket reopened",
    "ticket.ticketUpdated": "Ticket updated",
    "ticket.reopened": "Reopened",
    "ticket.st.open": "Open",
    "ticket.st.in_progress": "In progress",
    "ticket.st.resolved": "Resolved",
    "ticket.st.closed": "Closed",
    "ticket.heading": "Ticket update",
    "ticket.title": "{heading} — ticket #{ticket_id}",
    "ticket.number": "Ticket #{ticket_id}",
    "ticket.eventLine": "{event_line} — {subject}.",
    "ticket.status": "Status",
    "ticket.priority": "Priority",
    "ticket.openConversation": "Open the conversation",
    "ticket.openQueue": "Open the ticket queue",
    "ticket.fromStore": "{event_label} from {store_name}",
    "ticket.storeN": "store #{id}",
    "ticket.turnOff": "Don't want ticket updates? Turn them off on your {link}.",
    "ticket.userBody": (
        "Hi {name},\n"
        "\n"
        "{event_line} — \"{subject}\" (ticket #{ticket_id}).\n"
        "\n"
        "{detail_block}Open the conversation in DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "You're getting this because you filed the ticket. Turn ticket\n"
        "updates off on your notifications page:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),
    "ticket.platformBody": (
        "{event_label} on ticket #{ticket_id} — \"{subject}\"\n"
        "Store: {store_name}\n"
        "From: {actor_name}\n"
        "Status: {status} · Priority: {priority}\n"
        "\n"
        "{detail_block}Open the ticket queue:\n"
        "    {view_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Announcement broadcast (the message itself is the ──────
    #    superadmin's own words and stays as typed) ───────────
    "ann.genericSubject": "A message from DineroBook",
    "ann.kind.warning": "Heads up",
    "ann.kind.error": "Important",
    "ann.kind.success": "Update",
    "ann.kind.info": "Announcement",
    "ann.signedIn": "Signed in already? {link} to see the full banner in context.",
    "ann.open": "Open DineroBook",
    "ann.turnOff": (
        "Don't want announcement emails? Turn them off on your {link}. "
        "You'll still see announcements as in-app banners when you sign in."
    ),
    "ann.body": (
        "Announcement from DineroBook\n"
        "\n"
        "{message}\n"
        "\n"
        "— DineroBook ({base_url})\n"
        "\n"
        "Don't want announcement emails? Turn them off:\n"
        "  {notifications_url}\n"
    ),

    # ── Missed-shift digest (plain text) ───────────────────────
    "shifts.subject.one": "{store_name} — {count} missed shift · {date}",
    "shifts.subject.other": "{store_name} — {count} missed shifts · {date}",
    "shifts.lead": "Missed shifts on {date} at {store_name}:",
    "shifts.line": "  · {name} — scheduled {start} to {end}",
    "shifts.advice": (
        "No clock-in recorded for these cashiers on the planned date.  "
        "Re-schedule or back-fill via the admin time-clock page if the "
        "punch was actually made on a different terminal."
    ),
    "shifts.push.one": "{count} missed shift — tap to review.",
    "shifts.push.other": "{count} missed shifts — tap to review.",
    "shifts.yourStore": "Your store",
}


ES: Final[dict[str, str]] = {
    # ── Shared chrome (_base.html) ─────────────────────────────
    "base.footer": (
        "Recibe este correo porque su cuenta de {brand} está configurada "
        "para recibir avisos de la cuenta. Puede cambiar sus preferencias "
        "en su {link}."
    ),
    "base.notificationsPage": "página de notificaciones",
    "base.pasteLink": "O pegue esto en su navegador:",
    "base.hi": "Hola:",
    "base.hiName": "Hola, {name}:",

    # ── Password reset ─────────────────────────────────────────
    "reset.subject": "Restablezca su contraseña de DineroBook",
    "reset.preheader": "Restablezca su contraseña de DineroBook: el enlace vence en 1 hora.",
    "reset.heading": "Restablezca su contraseña",
    "reset.lead": (
        "Alguien (esperamos que usted) pidió restablecer la contraseña de "
        "su cuenta de DineroBook. Toque el botón de abajo dentro de la "
        "próxima hora para crear una nueva."
    ),
    "reset.button": "Crear contraseña nueva",
    "reset.pasteLink": "Si el botón no funciona, pegue este enlace en su navegador:",
    "reset.ignore": (
        "¿No lo pidió usted? Puede ignorar este correo sin problema: su "
        "contraseña actual seguirá funcionando. El enlace vence en una "
        "hora."
    ),
    "reset.body": (
        "Hola:\n\n"
        "Alguien (esperamos que usted) pidió restablecer la contraseña de "
        "su cuenta de DineroBook. Abra este enlace dentro de la próxima "
        "hora para crear una contraseña nueva:\n\n"
        "  {reset_url}\n\n"
        "Si no lo pidió usted, puede ignorar este correo sin problema: "
        "su contraseña actual seguirá funcionando.\n"
    ),

    # ── New sign-in alert ──────────────────────────────────────
    "signIn.subject": "Nuevo inicio de sesión en su cuenta de DineroBook",
    "signIn.title": "Nuevo inicio de sesión en su cuenta",
    "signIn.preheader": "{device} inició sesión en su cuenta",
    "signIn.lead": "Acaban de iniciar sesión en su cuenta desde un dispositivo que no había usado antes.",
    "signIn.device": "Dispositivo",
    "signIn.address": "Dirección IP",
    "signIn.when": "Cuándo",
    "signIn.advice": (
        "Si fue usted, no tiene que hacer nada. Si no fue usted, cierre "
        "la sesión de ese dispositivo y cambie su contraseña."
    ),
    "signIn.button": "Revisar mis dispositivos",
    "signIn.turnOff": "¿No quiere estos avisos? Desactívelos en su {link}.",
    "signIn.unknownIp": "desconocida",
    "signIn.unknownDevice": "Dispositivo desconocido",
    "signIn.browser": "Navegador",
    "signIn.deviceOn": "{browser} en {platform}",
    "signIn.pushBody": "{device} · {ip}. ¿No fue usted? Cierre esa sesión.",
    "signIn.body": (
        "Hola, {name}:\n"
        "\n"
        "Acaban de iniciar sesión en su cuenta de DineroBook ({username})\n"
        "desde un dispositivo que no había usado antes.\n"
        "\n"
        "    Dispositivo: {device}\n"
        "    Dirección:   {ip}\n"
        "    Cuándo:      {when}\n"
        "\n"
        "Si fue usted, no tiene que hacer nada.\n"
        "\n"
        "Si no fue usted, cierre la sesión de ese dispositivo y cambie su contraseña:\n"
        "    {devices_url}\n"
        "\n"
        "Recibe este correo porque tiene activados los avisos de inicio de sesión.\n"
        "Puede desactivarlos en su página de notificaciones:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Trial ending reminder ──────────────────────────────────
    "trial.subject": "Su prueba de DineroBook termina en {days} días",
    "trial.heading": "Su prueba termina en {days} días",
    "trial.preheader": "Su prueba de DineroBook para {store_name} termina el {trial_end_date}.",
    "trial.lead": (
        "Le avisamos: la prueba de DineroBook de {store_name} termina el "
        "{trial_end_date}. Para conservar sus libros, reportes e historial "
        "de envíos, suscríbase antes de esa fecha."
    ),
    "trial.button": "Suscribirse ahora",
    "trial.noAction": (
        "No tiene que hacer nada si prefiere dejar que la prueba termine. "
        "Guardamos sus datos 180 días después de la cancelación, así que "
        "puede volver sin perder su historial."
    ),
    "trial.turnOff": "¿No quiere recordatorios de la prueba? Desactívelos en su {link}.",
    "trial.body": (
        "Hola, {name}:\n"
        "\n"
        "Le avisamos que su prueba de DineroBook para \"{store_name}\" termina el\n"
        "{trial_end_date}. Faltan {days} días.\n"
        "\n"
        "Para conservar sus libros, reportes e historial de envíos, suscríbase\n"
        "antes de esa fecha:\n"
        "    {subscribe_url}\n"
        "\n"
        "No tiene que hacer nada si prefiere dejar que la prueba termine;\n"
        "guardamos sus datos 180 días después de la cancelación para que pueda volver.\n"
        "\n"
        "¿Ya no quiere recordatorios de la prueba? Desactívelos en su\n"
        "página de notificaciones:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),
    # ── Daily summary ──────────────────────────────────────────
    "daily.subject": "Resumen del día — {store_name}, {date_human}",
    "daily.heading": "Resumen del día",
    "daily.lead": "Este es el cierre de ayer de {store_name}.",
    "daily.figures": "{transfer_count} envíos · {send_volume} enviados",
    "daily.pushBody": "{figures} · neto {net}",
    "daily.transfers": "Envíos registrados",
    "daily.volume": "Monto enviado",
    "daily.receipts": "Entradas",
    "daily.disbursements": "Salidas",
    "daily.overShort": "Sobrante / faltante",
    "daily.net": "Posición neta",
    "daily.button": "Abrir en DineroBook",
    "daily.quietDays": (
        "Solo recibe este resumen los días con al menos un envío o una "
        "fila guardada en el libro diario. Los días sin movimiento no "
        "generan correo."
    ),
    "daily.turnOff": "¿No quiere los resúmenes del día? Desactívelos en su {link}.",
    "daily.body": (
        "Hola, {name}:\n"
        "\n"
        "Este es el cierre de ayer de \"{store_name}\" ({date_human}):\n"
        "\n"
        "  Envíos registrados    {transfer_count}\n"
        "  Monto enviado         {send_volume}\n"
        "  Entradas              {receipts}\n"
        "  Salidas               {disbursements}\n"
        "  Sobrante / faltante   {over_short}\n"
        "  Posición neta         {net}\n"
        "\n"
        "Abra el día en DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "Recibe este resumen porque figura como dueño o administrador de\n"
        "{store_name}. Puede desactivarlo en su página de notificaciones:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Locked-day digest ──────────────────────────────────────
    "locked.subject": "Libro diario cerrado — {store_name}, {date_human}",
    "locked.heading": "Libro diario cerrado",
    "locked.preheader": "Libro diario de {store_name} cerrado el {date_human}. Neto {net}.",
    "locked.lead": "El libro diario de {store_name} del {date_human} acaba de ser cerrado por {locked_by}.",
    "locked.anAdmin": "un administrador",
    "locked.pushBody": "Cerrado por {locked_by}. Neto {net}.",
    "locked.readOnly": (
        "Un día cerrado es solo de lectura: el cajero puede abrirlo de "
        "nuevo en la pantalla del libro diario si hay que corregir un "
        "número. Cada vez que se abre y se vuelve a cerrar llega un "
        "resumen nuevo, así verá las correcciones."
    ),
    "locked.turnOff": "¿No quiere los resúmenes de cierre? Desactívelos en su {link}.",
    "locked.body": (
        "Hola, {name}:\n"
        "\n"
        "El libro diario de \"{store_name}\" del {date_human} acaba de ser\n"
        "cerrado por {locked_by}.\n"
        "\n"
        "  Entradas              {receipts}\n"
        "  Salidas               {disbursements}\n"
        "  Sobrante / faltante   {over_short}\n"
        "  Posición neta         {net}\n"
        "\n"
        "Abra el día en DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "Recibe este resumen porque figura como dueño o administrador de\n"
        "{store_name}. Puede desactivarlo en su página de notificaciones:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Support ticket updates ─────────────────────────────────
    "ticket.userSubject": "Novedades de su ticket de soporte: {subject}",
    "ticket.platformSubject": "Ticket n.º {ticket_id} {store_name}: {event_label}",
    "ticket.staffReply": "Soporte respondió a su ticket",
    "ticket.statusChange": "Cambió el estado de su ticket",
    "ticket.updated": "Su ticket se actualizó",
    "ticket.created": "Ticket nuevo",
    "ticket.userReply": "Respuesta nueva",
    "ticket.reopenedEvent": "Ticket reabierto",
    "ticket.ticketUpdated": "Ticket actualizado",
    "ticket.reopened": "Reabierto",
    "ticket.st.open": "Abierto",
    "ticket.st.in_progress": "En curso",
    "ticket.st.resolved": "Resuelto",
    "ticket.st.closed": "Cerrado",
    "ticket.heading": "Novedades del ticket",
    "ticket.title": "{heading} — ticket n.º {ticket_id}",
    "ticket.number": "Ticket n.º {ticket_id}",
    "ticket.eventLine": "{event_line}: {subject}.",
    "ticket.status": "Estado",
    "ticket.priority": "Prioridad",
    "ticket.openConversation": "Abrir la conversación",
    "ticket.openQueue": "Abrir la lista de tickets",
    "ticket.fromStore": "{event_label} de {store_name}",
    "ticket.storeN": "tienda n.º {id}",
    "ticket.turnOff": "¿No quiere avisos de sus tickets? Desactívelos en su {link}.",
    "ticket.userBody": (
        "Hola, {name}:\n"
        "\n"
        "{event_line}: \"{subject}\" (ticket n.º {ticket_id}).\n"
        "\n"
        "{detail_block}Abra la conversación en DineroBook:\n"
        "    {view_url}\n"
        "\n"
        "Recibe este correo porque usted abrió el ticket. Puede desactivar\n"
        "estos avisos en su página de notificaciones:\n"
        "    {notifications_url}\n"
        "\n"
        "— DineroBook\n"
    ),
    "ticket.platformBody": (
        "{event_label} en el ticket n.º {ticket_id}: \"{subject}\"\n"
        "Tienda: {store_name}\n"
        "De: {actor_name}\n"
        "Estado: {status} · Prioridad: {priority}\n"
        "\n"
        "{detail_block}Abra la lista de tickets:\n"
        "    {view_url}\n"
        "\n"
        "— DineroBook\n"
    ),

    # ── Announcement broadcast ─────────────────────────────────
    "ann.genericSubject": "Un mensaje de DineroBook",
    "ann.kind.warning": "Atención",
    "ann.kind.error": "Importante",
    "ann.kind.success": "Novedad",
    "ann.kind.info": "Aviso",
    "ann.signedIn": "¿Ya inició sesión? {link} para ver el aviso completo en la app.",
    "ann.open": "Abra DineroBook",
    "ann.turnOff": (
        "¿No quiere avisos por correo? Desactívelos en su {link}. "
        "Seguirá viendo los avisos dentro de la app al iniciar sesión."
    ),
    "ann.body": (
        "Aviso de DineroBook\n"
        "\n"
        "{message}\n"
        "\n"
        "— DineroBook ({base_url})\n"
        "\n"
        "¿No quiere avisos por correo? Desactívelos aquí:\n"
        "  {notifications_url}\n"
    ),

    # ── Missed-shift digest (plain text) ───────────────────────
    "shifts.subject.one": "{store_name} — {count} turno no cumplido · {date}",
    "shifts.subject.other": "{store_name} — {count} turnos no cumplidos · {date}",
    "shifts.lead": "Turnos no cumplidos el {date} en {store_name}:",
    "shifts.line": "  · {name} — programado de {start} a {end}",
    "shifts.advice": (
        "No hay entrada registrada para estos cajeros en la fecha "
        "planeada. Reprograme o complete la marca en la página del reloj "
        "de asistencia si en realidad marcaron en otra terminal."
    ),
    "shifts.push.one": "{count} turno no cumplido: toque para revisarlo.",
    "shifts.push.other": "{count} turnos no cumplidos: toque para revisarlos.",
    "shifts.yourStore": "Su tienda",
}

CATALOGS: Final[dict[str, dict[str, str]]] = {"en": EN, "es": ES}


def placeholders(text: str) -> set[str]:
    """The ``{name}`` fields a catalog text expects."""
    return {f for _, f, _, _ in string.Formatter().parse(text) if f}


def _template(lang: str, key: str) -> str:
    catalog = CATALOGS.get(lang, EN)
    return catalog.get(key) or EN[key]


def email_t(lang: str, key: str, /, **vars: object) -> str:
    """``key`` in ``lang`` (English when unknown), placeholders filled.
    The values are inserted as given; an HTML template escapes them."""
    return _template(lang, key).format(**vars)


def email_tn(lang: str, base: str, count: int, /, **vars: object) -> str:
    """A count with its noun: ``base + ".one"`` for 1, ``".other"``
    otherwise (the rule English and Spanish share). ``{count}`` is
    filled with the number."""
    key = f"{base}.one" if count == 1 else f"{base}.other"
    return email_t(lang, key, count=count, **vars)


def email_t_html(lang: str, key: str, /, **vars: object) -> Markup:
    """For a sentence with markup in it (a ``<strong>`` store name, a
    link): the catalog text is trusted, and every value is escaped
    unless it is already ``Markup``."""
    return Markup(_template(lang, key)).format(**vars)


def bold(value: object) -> Markup:
    """A value set in the emails' dark bold, escaped."""
    return Markup('<strong style="color:#0a0a0a;">{}</strong>').format(value)


_ES_MONTHS: Final = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
    "agosto", "septiembre", "octubre", "noviembre", "diciembre",
)
_ES_MONTHS_SHORT: Final = (
    "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept",
    "oct", "nov", "dic",
)


_ES_WEEKDAYS: Final = (
    "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo",
)


def email_date(
    d: date, lang: str, *, english: str = "%B %d, %Y", weekday: bool = False,
) -> str:
    """A day as words. English keeps the format each sender always
    used (``english``, a strftime pattern); Spanish reads
    "5 de noviembre de 2026", or "jueves, 5 de noviembre de 2026"
    with ``weekday``."""
    if lang == "es":
        day = f"{d.day} de {_ES_MONTHS[d.month - 1]} de {d.year}"
        return f"{_ES_WEEKDAYS[d.weekday()]}, {day}" if weekday else day
    return d.strftime(english)


def email_time(t: time, lang: str) -> str:
    """``time(9, 0)`` → "9:00 AM" / "9:00 a. m." (12-hour, no leading
    zero, as the app shows it)."""
    hour = t.hour % 12 or 12
    if lang == "es":
        suffix = "a. m." if t.hour < 12 else "p. m."
    else:
        suffix = "AM" if t.hour < 12 else "PM"
    return f"{hour}:{t.minute:02d} {suffix}"


def email_datetime(local: datetime, lang: str, zone_label: str) -> str:
    """A moment in the reader's zone: "Oct 22, 2026 at 1:05 AM
    (America/Chicago)" / "22 oct 2026, 1:05 a. m. (America/Chicago)"."""
    if lang == "es":
        hour = local.hour % 12 or 12
        suffix = "a. m." if local.hour < 12 else "p. m."
        return (
            f"{local.day} {_ES_MONTHS_SHORT[local.month - 1]} {local.year}, "
            f"{hour}:{local.minute:02d} {suffix} ({zone_label})"
        )
    clock = local.strftime("%I:%M %p").lstrip("0")
    return f"{local.strftime('%b')} {local.day}, {local.year} at {clock} ({zone_label})"


__all__ = [
    "CATALOGS", "EN", "ES", "LANGUAGES", "bold", "email_date", "email_datetime",
    "email_language", "email_t", "email_t_html", "email_time", "email_tn",
    "placeholders",
]

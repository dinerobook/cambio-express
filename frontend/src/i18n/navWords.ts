// Spanish for the sidebar's group titles and page labels
// (UI-STANDARDS §10).
//
// NAV in components/navConfig.tsx stays in English: it is also the
// source of URLs (/hub/<slug>), page titles and breadcrumbs, and the
// "one name per page" guard compares those in English. The sidebar
// shows each label through `navWord()`. navWords.test.ts fails when a
// NAV title or label has no Spanish here, or when an entry here no
// longer matches anything in NAV.

import { getLanguage } from "./index";

export const NAV_WORDS_ES: Record<string, string> = {
  // Group titles
  "Dashboard": "Panel",
  "Daily": "Diario",
  "Money services": "Servicios de dinero",
  "Cash a check": "Cambiar un cheque",
  "Check cashing": "Cambio de cheques",
  "Finance": "Finanzas",
  "Reports": "Reportes",
  "Team": "Equipo",
  "Manage": "Administrar",
  "Displays": "Pantallas",
  "Owner": "Dueño",
  "Platform": "Plataforma",
  "Account": "Cuenta",
  // Page labels
  "ACH batches": "Lotes ACH",
  "Bad checks": "Cheques rebotados",
  "Check cashing report": "Reporte de cambio de cheques",
  "Checks": "Cheques",
  "Activity stream": "Actividad",
  "Add user to stores": "Agregar usuario a tiendas",
  "Announcements": "Anuncios",
  "Data export": "Exportar datos",
  "Audit log": "Registro de auditoría",
  "Bank accounts": "Cuentas bancarias",
  "Bank rules": "Reglas bancarias",
  "Bank transactions": "Movimientos bancarios",
  "Billing": "Facturación",
  "Bulk permissions": "Permisos en lote",
  "Companies": "Empresas",
  "Connect a store": "Conectar una tienda",
  "Controls": "Controles",
  "Cross-store defaults": "Valores para todas las tiendas",
  "Cross-store reports": "Reportes de todas las tiendas",
  "Customers": "Clientes",
  "Devices": "Dispositivos",
  "Discounts": "Descuentos",
  "Email log": "Registro de correos",
  "Employees": "Empleados",
  "Feature flags": "Funciones",
  "Health": "Estado del sistema",
  "Locations": "Ubicaciones",
  "Lottery": "Lotería",
  "MSB daily book": "Libro diario MSB",
  "MSB reports": "Reportes MSB",
  "Maintenance": "Mantenimiento",
  "My activity": "Mi actividad",
  "Notifications": "Notificaciones",
  "Owner settings": "Configuración del dueño",
  "Monthly P&L": "P&L mensual",
  "P&L rollup": "P&L consolidado",
  "Payroll": "Nómina",
  "Permissions": "Permisos",
  "Platform reports": "Reportes de la plataforma",
  "Price book": "Lista de precios",
  "Punch credentials": "Credenciales de marcación",
  "Purchases": "Compras",
  "Returned checks": "Cheques devueltos",
  "Roles & access": "Roles y acceso",
  "Rule templates": "Plantillas de reglas",
  "Setup progress": "Avance de la configuración",
  "Schedule": "Horario",
  "Settings": "Configuración",
  "Store daily book": "Libro diario de la tienda",
  "Store reports": "Reportes de la tienda",
  "Stores": "Tiendas",
  "Support": "Soporte",
  "TV display": "Pantalla de TV",
  "Team users": "Usuarios del equipo",
  "Tickets": "Solicitudes",
  "Time clock": "Reloj checador",
  "Transactions": "Transacciones",
  "Transfers": "Envíos",
  "Users": "Usuarios",
};

/** A NAV title or label in the current language. */
export function navWord(english: string): string {
  if (getLanguage() === "en") return english;
  return NAV_WORDS_ES[english] ?? english;
}

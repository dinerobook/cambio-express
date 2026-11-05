import { describe, expect, it } from "vitest";

import { en } from "./en";

// Translation guard (UI-STANDARDS §10). Every file listed here has
// been moved onto the translator: its visible words come from
// `t(...)` (i18n/en.ts + es.ts), never typed in English directly.
// A covered file that gains a raw English string fails here.
//
// Moving another screen into Spanish = translate it, then add its
// file to COVERED_FILES. Files leave this list only by being deleted.
export const COVERED_FILES = [
  // Sign-in
  "routes/Login.tsx",
  "routes/LoginStore.tsx",
  "routes/ForgotPassword.tsx",
  "routes/ResetPassword.tsx",
  "components/AuthChrome.tsx",
  "components/LanguageSwitch.tsx",
  // App shell
  "components/AppShell.tsx",
  "components/SlimSidebar.tsx",
  "components/UserMenu.tsx",
  "components/ThemeToggle.tsx",
  "components/NotificationBell.tsx",
  "components/UnsavedChangesHost.tsx",
  "components/PageCrumbs.tsx",
  // Kit pieces every screen shows
  "components/ui/Breadcrumbs.tsx",
  "components/ui/FormActions.tsx",
  "components/ui/Loading.tsx",
  "components/ui/Pager.tsx",
  "components/ui/MonthCalendar.tsx",
  "components/ui/PeriodStepper.tsx",
  // Daily book
  "routes/DailyBook.tsx",
  "routes/EditDailyBook.tsx",
  "routes/DailyBookSettlements.tsx",
  "routes/DailyBookTile.tsx",
  // Transfers
  "routes/Transfers.tsx",
  "routes/NewTransfer.tsx",
  "routes/EditTransfer.tsx",
  "routes/TransferDetail.tsx",
  "routes/TransferReceipt.tsx",
  "components/TransferKindPill.tsx",
  "components/DebitCardCheckbox.tsx",
  "components/FederalTaxPreview.tsx",
  "components/StoreListField.tsx",
  "components/SenderAutocomplete.tsx",
  "components/RecipientSuggestions.tsx",
  "lib/transferKinds.ts",
  // Kit pieces the transfer screens show
  "components/ui/TableStates.tsx",
  "components/ui/ErrorState.tsx",
  "components/ui/Toast.tsx",
  "components/ui/InfoTip.tsx",
  "components/ui/RowActions.tsx",
  // Subscribe (plan picker)
  "routes/Subscribe.tsx",
  // Step 4a: dashboard, customers, ACH batches, return checks
  "routes/Dashboard.tsx",
  "routes/Customers.tsx",
  "routes/Batches.tsx",
  "routes/BatchForm.tsx",
  "routes/ReturnChecks.tsx",
  "routes/ReturnCheckForm.tsx",
  // Team: employees, logins, roles and the time clock
  "routes/Employees.tsx",
  "routes/EmployeeForm.tsx",
  "routes/AdminUserForm.tsx",
  "routes/RolesAccess.tsx",
  "routes/RoleEdit.tsx",
  "routes/AdminTimeClock.tsx",
  "routes/AdminTimeClockSchedule.tsx",
  "routes/AdminTimeClockCredentials.tsx",
  "routes/TimeClock.tsx",
  "routes/TimeClockPaystub.tsx",
  // Settings and account pages
  "routes/Settings.tsx",
  "routes/SettingsMoneyServices.tsx",
  "routes/AccountNotifications.tsx",
  "routes/AccountSessions.tsx",
  "routes/AccountActivity.tsx",
  "routes/AdminAuditLog.tsx",
  "components/AuditTable.tsx",
  "components/AuditActionBadge.tsx",
  "components/auditFilters.ts",
  "routes/AdminReferrals.tsx",
  "routes/AdminDataExport.tsx",
  "components/SwitchStoreModal.tsx",
  "components/RolePermissionsEditor.tsx",
  "components/PermissionMatrixTable.tsx",
  "components/RolePill.tsx",
  // The rest of the kit and the shell pieces every page can show
  "components/ui/Tabs.tsx",
  "components/ui/Modal.tsx",
  "components/ui/DataTable.tsx",
  "components/ui/CopyField.tsx",
  "components/ui/PhoneField.tsx",
  "components/ui/Field.tsx",
  "components/ui/MoneyInput.tsx",
  "components/ui/DateInput.tsx",
  "components/ui/Empty.tsx",
  "components/ui/Alert.tsx",
  "components/ui/Button.tsx",
  "components/ui/Tooltip.tsx",
  "components/ui/Switch.tsx",
  "components/ui/KpiCard.tsx",
  "components/ui/IconButton.tsx",
  "components/ui/Checkbox.tsx",
  "components/ui/Pill.tsx",
  "components/ui/PageHeader.tsx",
  "components/ui/Section.tsx",
  "components/ui/Table.tsx",
  "components/ui/Select.tsx",
  "components/ui/Textarea.tsx",
  "components/ui/Input.tsx",
  "components/StoreGate.tsx",
  "components/RouteErrorBoundary.tsx",
  "components/CommandPalette.tsx",
  "components/HelpCenter.tsx",
  "components/AnnouncementBanner.tsx",
  "components/ImpersonationBanner.tsx",
  "components/InstallAppButton.tsx",
  "components/PeriodRollup.tsx",
  "components/RegisterActivity.tsx",
  "components/RequireAuth.tsx",
  "components/Gate.tsx",
  "components/Delta.tsx",
  "components/DisplayTimezone.tsx",
  "components/BrandLink.tsx",
  "components/RolePill.tsx",
  "routes/NotFound.tsx",
  "routes/Home.tsx",
  "routes/SectionHub.tsx",
];

const sources = import.meta.glob(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.d.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function source(file: string): string {
  const key = Object.keys(sources).find((p) => p.endsWith(`/${file}`));
  if (!key) throw new Error(`covered file missing: ${file}`);
  return sources[key];
}

/** Source without comments, so prose in comments never trips it. */
function code(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// Text that is not a word to translate: symbols, numbers, the brand.
const NOT_WORDS = /^[\s$·|—–•…←→✓#%0-9.,:()+-]*$|^\$$|^DineroBook$/;
// Acronyms read the same in both languages: MRR, ACH, CSV.
const ACRONYM = /^[A-Z]{2,5}$/;
// Examples that read the same in every language.
const EXAMPLE = /^[\w.+-]+@[\w-]+\.[\w.]+$|^\+?[\d ()-]+$/;

function rawStrings(src: string): string[] {
  const body = code(src);
  const found: string[] = [];
  // JSX text between tags: >Sign in<
  // `(?<!=)`: an arrow's `=>` is code (`() => Promise<void>`), not a tag.
  for (const m of body.matchAll(/(?<!=)>([^<>{}]*[A-Za-z]{2}[^<>{}]*)</g)) {
    const text = m[1].trim();
    // Skip TypeScript, not JSX: generics and comparisons like
    // `useState<X | null>(null); … <` contain code punctuation.
    if (/[;=()&|]|=>/.test(text)) continue;
    // An object key between two JSX values: `a: <b>x</b>, name: <b>`.
    if (/^,?\s*\w+:$/.test(text)) continue;
    if (!NOT_WORDS.test(text)) found.push(text);
  }
  // Visible attributes: label="…", placeholder="…", title="…", …
  for (const m of body.matchAll(
    /\b(label|placeholder|title|aria-label|alt|confirmLabel|cancelLabel|message)="([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    if (!EXAMPLE.test(m[2]) && !ACRONYM.test(m[2])) found.push(`${m[1]}="${m[2]}"`);
  }
  // The same attributes as a template: title={`Transfer #${id}`}.
  for (const m of body.matchAll(
    /\b(label|placeholder|title|aria-label|alt|confirmLabel|cancelLabel|message|current)=\{`([^`]*)`\}/g,
  )) {
    const words = m[2].replace(/\$\{[^}]*\}/g, "");
    if (/[A-Za-z]{2}/.test(words)) found.push(`${m[1]}={\`${m[2]}\`}`);
  }
  // Object-literal labels and error setters: label: "…", setError("…")
  // (`header` is a DataTable column's heading).
  for (const m of body.matchAll(
    /\b(label|title|message|header):\s*"([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    // A config table naming its words by translator key is fine.
    if (!(m[2] in en)) found.push(`${m[1]}: "${m[2]}"`);
  }
  for (const m of body.matchAll(
    /\b(setError|setMsg|apiErrorMessage\([^,]+,)\s*\(?\s*"([^"]*[A-Za-z]{2}[^"]*)"/g,
  )) {
    // react-hook-form's form-wide error slot is named "root".
    if (m[2] !== "root") found.push(`${m[1]}("${m[2]}")`);
  }
  // A ternary between two English words: busy ? "Saving…" : "Save"
  // (capitalised, so CSS classes and option values don't count).
  for (const m of body.matchAll(/[?:]\s*"([A-Z][^"]*[a-z]{2}[^"]*)"/g)) {
    found.push(`branch "${m[1]}"`);
  }
  return found;
}

describe("translation guard", () => {
  it("finds every covered file", () => {
    for (const f of COVERED_FILES) expect(() => source(f)).not.toThrow();
  });

  it.each(COVERED_FILES)("%s shows no raw English", (file) => {
    expect(rawStrings(source(file))).toEqual([]);
  });

  it("catches the patterns it is meant to catch", () => {
    // Self-test: a guard that matches nothing guards nothing.
    const sample = [
      `<h2 className={x}>Sign in</h2>`,
      `<Field label="Email or phone">`,
      `navLink={{ to: "/x", label: "Create an account" }}`,
      `setError("Passwords do not match.");`,
      `{busy ? "Saving…" : "Save changes"}`,
      `{ key: "date", header: "Date" }`,
      `<PageHeader title={\`Transfer #\${id}\`} />`,
    ].join("\n");
    expect(rawStrings(sample)).toHaveLength(10);
    expect(rawStrings(`<Crumbs current={\`\${a} · \${b}\`} />`)).toEqual([]);
    expect(rawStrings(`<h2>{t("login.title")}</h2> // Sign in`)).toEqual([]);
  });
});

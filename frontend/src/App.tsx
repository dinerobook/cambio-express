import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import AppShell from "./components/AppShell";
import RequireAuth from "./components/RequireAuth";
import Gate from "./components/Gate";
import { RouteErrorBoundary } from "./components/RouteErrorBoundary";
import { Loading, ToastProvider } from "./components/ui";
import Home from "./routes/Home";
import NotFound from "./routes/NotFound";

// Eager: tiny bounce + 404 modules that should be in the entry chunk
// so the first paint never blocks on a network round-trip. Everything
// else is lazy — the bundle splits per-route via Vite's dynamic-import
// handling. Chart.js (~190KB minified) only loads for routes that
// render charts (owner dashboard + superadmin BI drilldowns).

const AccountActivity = lazy(() => import("./routes/AccountActivity"));
const AccountNotifications = lazy(() => import("./routes/AccountNotifications"));
const AccountSessions = lazy(() => import("./routes/AccountSessions"));
const AdminAuditLog = lazy(() => import("./routes/AdminAuditLog"));
const Employees = lazy(() => import("./routes/Employees"));
const EmployeeForm = lazy(() => import("./routes/EmployeeForm"));
const AdminSubscription = lazy(() => import("./routes/AdminSubscription"));
const AdminDataExport = lazy(() => import("./routes/AdminDataExport"));
const SupportTickets = lazy(() => import("./routes/SupportTickets"));
const SuperadminTickets = lazy(() => import("./routes/SuperadminTickets"));
const AdminTimeClock = lazy(() => import("./routes/AdminTimeClock"));
const AdminTimeClockCredentials = lazy(
  () => import("./routes/AdminTimeClockCredentials"),
);
const AdminTimeClockSchedule = lazy(
  () => import("./routes/AdminTimeClockSchedule"),
);
const AdminUserForm = lazy(() => import("./routes/AdminUserForm"));
const Bank = lazy(() => import("./routes/Bank"));
const BankRules = lazy(() => import("./routes/BankRules"));
const BankTransactions = lazy(() => import("./routes/BankTransactions"));
const Batches = lazy(() => import("./routes/Batches"));
const BatchForm = lazy(() => import("./routes/BatchForm"));
const Customers = lazy(() => import("./routes/Customers"));
const DailyBook = lazy(() => import("./routes/DailyBook"));
const Dashboard = lazy(() => import("./routes/Dashboard"));
const EditDailyBook = lazy(() => import("./routes/EditDailyBook"));
const EditMonthly = lazy(() => import("./routes/EditMonthly"));
const EditTransfer = lazy(() => import("./routes/EditTransfer"));
const ForgotPassword = lazy(() => import("./routes/ForgotPassword"));
const ItemMovement = lazy(() => import("./routes/ItemMovement"));
const Login = lazy(() => import("./routes/Login"));
const LoginStore = lazy(() => import("./routes/LoginStore"));
const Monthly = lazy(() => import("./routes/Monthly"));
const NewTransfer = lazy(() => import("./routes/NewTransfer"));
const OwnerBulkAddUser = lazy(() => import("./routes/OwnerBulkAddUser"));
const OwnerCrossStoreDefaults = lazy(
  () => import("./routes/OwnerCrossStoreDefaults"),
);
const OwnerUsers = lazy(() => import("./routes/OwnerUsers"));
const OwnerStorePermissions = lazy(
  () => import("./routes/OwnerStorePermissions"),
);
const OwnerSettings = lazy(() => import("./routes/OwnerSettings"));
const OwnerActivity = lazy(() => import("./routes/OwnerActivity"));
const OwnerBulkPermissions = lazy(
  () => import("./routes/OwnerBulkPermissions"),
);
const OwnerConnect = lazy(() => import("./routes/OwnerConnect"));
const OwnerDashboard = lazy(() => import("./routes/OwnerDashboard"));
const OwnerLocations = lazy(() => import("./routes/OwnerLocations"));
const OwnerPLRollup = lazy(() => import("./routes/OwnerPLRollup"));
const OwnerBilling = lazy(() => import("./routes/OwnerBilling"));
const StoreBookMonth = lazy(() => import("./routes/StoreBookMonth"));
const StoreBookDay = lazy(() => import("./routes/StoreBookDay"));
const OwnerReports = lazy(() => import("./routes/OwnerReports"));
const OwnerStoreDetail = lazy(() => import("./routes/OwnerStoreDetail"));
const Privacy = lazy(() => import("./routes/Privacy"));
const Reports = lazy(() => import("./routes/Reports"));
const ResetPassword = lazy(() => import("./routes/ResetPassword"));
const ReturnCheckForm = lazy(() => import("./routes/ReturnCheckForm"));
const Lottery = lazy(() => import("./routes/Lottery"));
const PriceBook = lazy(() => import("./routes/PriceBook"));
const PurchaseInvoices = lazy(() => import("./routes/PurchaseInvoices"));
const PurchaseInvoiceForm = lazy(
  () => import("./routes/PurchaseInvoiceForm"),
);
const PosImport = lazy(() => import("./routes/PosImport"));
const ReturnChecks = lazy(() => import("./routes/ReturnChecks"));
const SectionHub = lazy(() => import("./routes/SectionHub"));
const Settings = lazy(() => import("./routes/Settings"));
const StorePermissions = lazy(() => import("./routes/StorePermissions"));
const SettingsProfile = lazy(
  () => import("./routes/Settings").then(
    (m) => ({ default: m.SettingsProfile }),
  ),
);
const SettingsGeneral = lazy(
  () => import("./routes/Settings").then(
    (m) => ({ default: m.SettingsGeneral }),
  ),
);
const SettingsBilling = lazy(
  () => import("./routes/Settings").then(
    (m) => ({ default: m.SettingsBilling }),
  ),
);
const SettingsSecurity = lazy(
  () => import("./routes/Settings").then(
    (m) => ({ default: m.SettingsSecurity }),
  ),
);
const SettingsReferrals = lazy(() => import("./routes/AdminReferrals"));
const Signup = lazy(() => import("./routes/Signup"));
const SignupOwner = lazy(() => import("./routes/SignupOwner"));
const Subscribe = lazy(() => import("./routes/Subscribe"));
const SubscribeSuccess = lazy(() => import("./routes/SubscribeSuccess"));
const SuperadminAnnouncements = lazy(() => import("./routes/SuperadminAnnouncements"));
const SuperadminAuditLog = lazy(() => import("./routes/SuperadminAuditLog"));
const SuperadminControls = lazy(() => import("./routes/SuperadminControls"));
const SuperadminDashboard = lazy(() => import("./routes/SuperadminDashboard"));
const SuperadminDiscounts = lazy(() => import("./routes/SuperadminDiscounts"));
const SuperadminFeatureFlags = lazy(() => import("./routes/SuperadminFeatureFlags"));
const SuperadminBilling = lazy(() => import("./routes/SuperadminBilling"));
const SuperadminEmailLog = lazy(() => import("./routes/SuperadminEmailLog"));
const SuperadminHealth = lazy(() => import("./routes/SuperadminHealth"));
const SuperadminMaintenance = lazy(() => import("./routes/SuperadminMaintenance"));
const SuperadminStoreDrill = lazy(() => import("./routes/SuperadminStoreDrill"));
const SuperadminPermissions = lazy(() => import("./routes/SuperadminPermissions"));
const SuperadminReports = lazy(() => import("./routes/SuperadminReports"));
const SuperadminStoreForm = lazy(() => import("./routes/SuperadminStoreForm"));
const SuperadminStores = lazy(() => import("./routes/SuperadminStores"));
const SuperadminUsers = lazy(() => import("./routes/SuperadminUsers"));
const TimeClock = lazy(() => import("./routes/TimeClock"));
const Transactions = lazy(() => import("./routes/Transactions"));
const TransactionDetail = lazy(
  () => import("./routes/TransactionDetail"),
);
const TimeClockPaystub = lazy(() => import("./routes/TimeClockPaystub"));
const TransferDetail = lazy(() => import("./routes/TransferDetail"));
// Receipt printing surface is hidden until we decide we need it —
// this is a ledger-only product, so customer-facing receipts don't
// belong here. The route + backend stay in place so re-enabling is
// a one-line revert. Import kept as a side-effect-free reference so
// the lazy chunk gets tree-shaken out of the build.
// const TransferReceipt = lazy(() => import("./routes/TransferReceipt"));
const Transfers = lazy(() => import("./routes/Transfers"));
const TVDisplayAdmin = lazy(() => import("./routes/TVDisplayAdmin"));
const TVDisplayOverview = lazy(
  () => import("./routes/TVDisplayAdmin").then(
    (m) => ({ default: m.TVDisplayOverview }),
  ),
);
const TVDisplayContent = lazy(
  () => import("./routes/TVDisplayAdmin").then(
    (m) => ({ default: m.TVDisplayContent }),
  ),
);
const TVDisplayDevice = lazy(
  () => import("./routes/TVDisplayAdmin").then(
    (m) => ({ default: m.TVDisplayDevice }),
  ),
);
const TVDisplayCountry = lazy(() => import("./routes/TVDisplayCountry"));

// TwoFactor.tsx exports three named components from one file. They share
// a 2FA chrome bundle, so co-locating them in the same chunk is correct;
// we unwrap the named exports into default-shaped lazy promises.
const TwoFactorEnroll = lazy(() =>
  import("./routes/TwoFactor").then((m) => ({ default: m.TwoFactorEnroll })),
);
const TwoFactorRecover = lazy(() =>
  import("./routes/TwoFactor").then((m) => ({ default: m.TwoFactorRecover })),
);
const TwoFactorVerify = lazy(() =>
  import("./routes/TwoFactor").then((m) => ({ default: m.TwoFactorVerify })),
);

// Reports.
const AchVolume = lazy(() => import("./routes/reports/AchVolume"));
const BankChargesByAccount = lazy(() => import("./routes/reports/BankChargesByAccount"));
const BankRuleAudit = lazy(() => import("./routes/reports/BankRuleAudit"));
const BankTxnBreakdown = lazy(() => import("./routes/reports/BankTxnBreakdown"));
const ByDestinationCountry = lazy(() => import("./routes/reports/ByDestinationCountry"));
const CancelledTransfers = lazy(() => import("./routes/reports/CancelledTransfers"));
const CashierProductivity = lazy(() => import("./routes/reports/CashierProductivity"));
const CheckDeposits = lazy(() => import("./routes/reports/CheckDeposits"));
const DailyDrops = lazy(() => import("./routes/reports/DailyDrops"));
const EmployeeActivity = lazy(() => import("./routes/reports/EmployeeActivity"));
const FeesVsTax = lazy(() => import("./routes/reports/FeesVsTax"));
const HighValueTransfers = lazy(() => import("./routes/reports/HighValueTransfers"));
const NewVsReturning = lazy(() => import("./routes/reports/NewVsReturning"));
const PeriodComparison = lazy(() => import("./routes/reports/PeriodComparison"));
const PeriodPL = lazy(() => import("./routes/reports/PeriodPL"));
const ReturnedCheckStatus = lazy(() => import("./routes/reports/ReturnedCheckStatus"));
const SalesByCompany = lazy(() => import("./routes/reports/SalesByCompany"));
const SalesByEmployee = lazy(() => import("./routes/reports/SalesByEmployee"));
const SalesByService = lazy(() => import("./routes/reports/SalesByService"));
const SuperadminBIDrilldown = lazy(() => import("./routes/reports/SuperadminBIDrilldown"));
const TopCustomers = lazy(() => import("./routes/reports/TopCustomers"));
const TopRecipients = lazy(() => import("./routes/reports/TopRecipients"));
const TopSenders = lazy(() => import("./routes/reports/TopSenders"));

// Top-level routing for the SPA.
//
//   /              → bounces to /login or /dashboard
//   /login         → unauthed-only login form (no shell)
//   <AuthedShell>  → applies RequireAuth + AppShell (sidebar +
//                     topbar) to every nested route
//     /dashboard, /transfers, /transfers/:id, /customers,
//     /daily, /reports
//
// Adding a new authed screen = adding one nested <Route> under
// the AuthedShell layout — no need to repeat RequireAuth +
// AppShell wrappers per page.
//
// Every <Route> element is a lazy() chunk; the global <Suspense>
// boundary below renders <Loading /> during the chunk fetch. Per-
// route error boundaries are tracked separately as BACKLOG C4.
export default function App() {
  return (
    <RouteErrorBoundary routeName="spa-root">
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<Home />} />
        <Route path="login"               element={<Login />} />
        <Route path="login/2fa"           element={<TwoFactorVerify />} />
        <Route path="login/2fa/enroll"    element={<TwoFactorEnroll />} />
        <Route path="login/2fa/recover"   element={<TwoFactorRecover />} />
        <Route path="login/:slug"         element={<LoginStore />} />
        <Route path="signup"           element={<Signup />} />
        <Route path="signup/owner"     element={<SignupOwner />} />
        <Route path="forgot-password"  element={<ForgotPassword />} />
        <Route path="reset-password"   element={<ResetPassword />} />
        <Route path="privacy"          element={<Privacy />} />
        <Route element={<AuthedShell />}>
          <Route path="home"             element={<Navigate to="/dashboard" replace />} />
          {/* Section-hub tile landings — one per nav section, driven
              by the same role-filtered NAV the sidebar uses. */}
          <Route path="hub/:key"         element={<Gate><SectionHub /></Gate>} />
          <Route path="dashboard"        element={<Gate><Dashboard /></Gate>} />
          <Route path="transfers"        element={<Gate><Transfers /></Gate>} />
          <Route path="transfers/new"      element={<Gate><NewTransfer /></Gate>} />
          <Route path="transfers/:id"         element={<Gate><TransferDetail /></Gate>} />
          <Route path="transfers/:id/edit"    element={<Gate><EditTransfer /></Gate>} />
          {/* Receipt printing surface hidden — see lazy-import comment above. */}
          <Route path="customers"        element={<Gate><Customers /></Gate>} />
          <Route path="daily"            element={<Gate><DailyBook /></Gate>} />
          <Route path="daily/edit"       element={<Gate><EditDailyBook /></Gate>} />
          <Route path="reports"          element={<Gate><Reports /></Gate>} />
          <Route path="store-reports"    element={<Gate><Reports collection="store" /></Gate>} />
          <Route path="store-reports/item-movement" element={<Gate><ItemMovement /></Gate>} />
          <Route path="reports/sales-by-company"      element={<Gate><SalesByCompany /></Gate>} />
          <Route path="reports/sales-by-service-type" element={<Gate><SalesByService /></Gate>} />
          <Route path="reports/sales-by-employee"     element={<Gate><SalesByEmployee /></Gate>} />
          <Route path="reports/cashier-productivity"  element={<Gate><CashierProductivity /></Gate>} />
          <Route path="reports/top-customers"   element={<Gate><TopCustomers /></Gate>} />
          <Route path="reports/top-senders"     element={<Gate><TopSenders /></Gate>} />
          <Route path="reports/top-recipients"  element={<Gate><TopRecipients /></Gate>} />
          <Route path="reports/new-vs-returning"       element={<Gate><NewVsReturning /></Gate>} />
          <Route path="reports/by-destination-country" element={<Gate><ByDestinationCountry /></Gate>} />
          <Route path="reports/fees-vs-tax"            element={<Gate><FeesVsTax /></Gate>} />
          <Route path="reports/high-value-transfers"   element={<Gate><HighValueTransfers /></Gate>} />
          <Route path="reports/cancelled-transfers"    element={<Gate><CancelledTransfers /></Gate>} />
          <Route path="reports/ach-volume"             element={<Gate><AchVolume /></Gate>} />
          <Route path="reports/returned-check-status"       element={<Gate><ReturnedCheckStatus /></Gate>} />
          <Route path="reports/bank-transactions-breakdown" element={<Gate><BankTxnBreakdown /></Gate>} />
          <Route path="reports/daily-drops"                 element={<Gate><DailyDrops /></Gate>} />
          <Route path="reports/check-deposits"              element={<Gate><CheckDeposits /></Gate>} />
          <Route path="reports/bank-rule-audit"             element={<Gate><BankRuleAudit /></Gate>} />
          <Route path="reports/bank-charges-by-account"     element={<Gate><BankChargesByAccount /></Gate>} />
          <Route path="reports/period-comparison"           element={<Gate><PeriodComparison /></Gate>} />
          <Route path="reports/employee-activity"           element={<Gate><EmployeeActivity /></Gate>} />
          <Route path="reports/period-pl"                   element={<Gate><PeriodPL /></Gate>} />
          <Route path="superadmin/reports/:slug"            element={<Gate><SuperadminBIDrilldown /></Gate>} />
          <Route path="owner/reports/sales-by-company"      element={<Gate><SalesByCompany /></Gate>} />
          <Route path="owner/reports/sales-by-service-type" element={<Gate><SalesByService /></Gate>} />
          <Route path="owner/reports/sales-by-employee"     element={<Gate><SalesByEmployee /></Gate>} />
          <Route path="owner/reports/cashier-productivity"  element={<Gate><CashierProductivity /></Gate>} />
          <Route path="owner/reports/top-customers"  element={<Gate><TopCustomers /></Gate>} />
          <Route path="owner/reports/top-senders"    element={<Gate><TopSenders /></Gate>} />
          <Route path="owner/reports/top-recipients"        element={<Gate><TopRecipients /></Gate>} />
          <Route path="owner/reports/new-vs-returning"       element={<Gate><NewVsReturning /></Gate>} />
          <Route path="owner/reports/by-destination-country" element={<Gate><ByDestinationCountry /></Gate>} />
          <Route path="owner/reports/fees-vs-tax"            element={<Gate><FeesVsTax /></Gate>} />
          <Route path="owner/reports/high-value-transfers"   element={<Gate><HighValueTransfers /></Gate>} />
          <Route path="owner/reports/cancelled-transfers"    element={<Gate><CancelledTransfers /></Gate>} />
          <Route path="owner/reports/ach-volume"             element={<Gate><AchVolume /></Gate>} />
          <Route path="owner/reports/returned-check-status"       element={<Gate><ReturnedCheckStatus /></Gate>} />
          <Route path="owner/reports/bank-transactions-breakdown" element={<Gate><BankTxnBreakdown /></Gate>} />
          <Route path="owner/reports/daily-drops"                 element={<Gate><DailyDrops /></Gate>} />
          <Route path="owner/reports/check-deposits"              element={<Gate><CheckDeposits /></Gate>} />
          <Route path="owner/reports/bank-rule-audit"             element={<Gate><BankRuleAudit /></Gate>} />
          <Route path="owner/reports/bank-charges-by-account"     element={<Gate><BankChargesByAccount /></Gate>} />
          <Route path="owner/reports/period-comparison"           element={<Gate><PeriodComparison /></Gate>} />
          <Route path="owner/reports/employee-activity"           element={<Gate><EmployeeActivity /></Gate>} />
          <Route path="owner/reports/period-pl"                   element={<Gate><PeriodPL /></Gate>} />
          <Route path="batches"          element={<Gate><Batches /></Gate>} />
          <Route path="batches/new"      element={<Gate><BatchForm /></Gate>} />
          <Route path="batches/:id/edit" element={<Gate><BatchForm /></Gate>} />
          <Route path="bank"             element={<Gate><Bank /></Gate>} />
          <Route path="bank/rules"       element={<Gate><BankRules /></Gate>} />
          <Route path="bank-transactions" element={<Gate><BankTransactions /></Gate>} />
          <Route path="monthly"          element={<Gate><Monthly /></Gate>} />
          <Route path="monthly/edit"     element={<Gate><EditMonthly /></Gate>} />
          <Route path="lottery"                element={<Gate><Lottery /></Gate>} />
          <Route path="store-book"             element={<Gate><StoreBookMonth /></Gate>} />
          <Route path="store-book/day"         element={<Gate><StoreBookDay /></Gate>} />
          {/* Day close folded into the store daily book — the day
              sheet carries the register detail as a section. Kept as
              a redirect for bookmarks and old links. */}
          <Route path="day-close"              element={<Navigate to="/store-book" replace />} />
          <Route path="pos-import"             element={<Gate><PosImport /></Gate>} />
          {/* Reading a ticket is a reporting act — day_close.read,
              not the update right that books a day. */}
          <Route path="transactions"           element={<Gate><Transactions /></Gate>} />
          <Route path="transactions/:id"       element={<Gate><TransactionDetail /></Gate>} />
          <Route path="price-book"             element={<Gate><PriceBook /></Gate>} />
          <Route path="purchase-invoices"      element={<Gate><PurchaseInvoices /></Gate>} />
          <Route path="purchase-invoices/new"  element={<Gate><PurchaseInvoiceForm /></Gate>} />
          <Route path="purchase-invoices/:id"  element={<Gate><PurchaseInvoiceForm /></Gate>} />
          <Route path="return-checks"          element={<Gate><ReturnChecks /></Gate>} />
          <Route path="return-checks/new"      element={<Gate><ReturnCheckForm /></Gate>} />
          <Route path="return-checks/:id/edit" element={<Gate><ReturnCheckForm /></Gate>} />
          <Route path="owner/connect"        element={<Gate><OwnerConnect /></Gate>} />
          <Route path="owner/dashboard"      element={<Gate><OwnerDashboard /></Gate>} />
          <Route path="owner/locations"      element={<Gate><OwnerLocations /></Gate>} />
          <Route path="owner/pl-rollup"      element={<Gate><OwnerPLRollup /></Gate>} />
          <Route path="owner/billing"        element={<Gate><OwnerBilling /></Gate>} />
          <Route path="owner/reports"        element={<Gate><OwnerReports /></Gate>} />
          <Route path="owner/bulk-add-user"          element={<Gate><OwnerBulkAddUser /></Gate>} />
          <Route path="owner/cross-store-defaults"   element={<Gate><OwnerCrossStoreDefaults /></Gate>} />
          <Route path="owner/users"                  element={<Gate><OwnerUsers /></Gate>} />
          <Route path="owner/settings"               element={<Gate><OwnerSettings /></Gate>} />
          <Route path="owner/activity"               element={<Gate><OwnerActivity /></Gate>} />
          <Route path="owner/bulk-permissions"        element={<Gate><OwnerBulkPermissions /></Gate>} />
          <Route path="owner/store/:storeId/permissions" element={<Gate><OwnerStorePermissions /></Gate>} />
          <Route path="owner/store/:storeId" element={<Gate><OwnerStoreDetail /></Gate>} />
          <Route path="superadmin/dashboard"     element={<Gate><SuperadminDashboard /></Gate>} />
          <Route path="superadmin/billing"       element={<Gate><SuperadminBilling /></Gate>} />
          <Route path="superadmin/email-log"     element={<Gate><SuperadminEmailLog /></Gate>} />
          <Route path="superadmin/health"        element={<Gate><SuperadminHealth /></Gate>} />
          <Route path="superadmin/maintenance"   element={<Gate><SuperadminMaintenance /></Gate>} />
          <Route path="superadmin/stores/:id/drill" element={<Gate><SuperadminStoreDrill /></Gate>} />
          <Route path="superadmin/permissions"   element={<Gate><SuperadminPermissions /></Gate>} />
          <Route path="superadmin/stores"        element={<Gate><SuperadminStores /></Gate>} />
          <Route path="superadmin/users"         element={<Gate><SuperadminUsers /></Gate>} />
          <Route path="superadmin/stores/new"    element={<Gate><SuperadminStoreForm /></Gate>} />
          <Route path="superadmin/stores/:id/edit" element={<Gate><SuperadminStoreForm /></Gate>} />
          <Route path="superadmin/audit-log"     element={<Gate><SuperadminAuditLog /></Gate>} />
          <Route path="superadmin/announcements" element={<Gate><SuperadminAnnouncements /></Gate>} />
          <Route path="superadmin/tickets"       element={<Gate><SuperadminTickets /></Gate>} />
          <Route path="superadmin/controls"      element={<Gate><SuperadminControls /></Gate>} />
          <Route path="superadmin/feature-flags" element={<Gate><SuperadminFeatureFlags /></Gate>} />
          <Route path="superadmin/discounts"     element={<Gate><SuperadminDiscounts /></Gate>} />
          <Route path="superadmin/reports"       element={<Gate><SuperadminReports /></Gate>} />
          <Route path="subscribe"             element={<Gate><Subscribe /></Gate>} />
          <Route path="subscribe/success"     element={<Gate><SubscribeSuccess /></Gate>} />
          <Route path="admin/subscription"    element={<Gate><AdminSubscription /></Gate>} />
          <Route path="admin/data-export"     element={<Gate><AdminDataExport /></Gate>} />
          <Route path="admin/timeclock"               element={<Gate><AdminTimeClock /></Gate>} />
          <Route path="admin/timeclock/credentials"   element={<Gate><AdminTimeClockCredentials /></Gate>} />
          <Route path="admin/timeclock/schedule"      element={<Gate><AdminTimeClockSchedule /></Gate>} />
          <Route path="admin/timeclock/paystub/:id"   element={<Gate><TimeClockPaystub /></Gate>} />
          <Route path="admin/audit-log"       element={<Gate><AdminAuditLog /></Gate>} />
          <Route path="admin/store-permissions" element={<Gate><StorePermissions /></Gate>} />
          {/* Unified Employees hub (E-2) — merges the old Cashiers
              roster + Team Users pages into one person-centric
              place. /admin/users/* survives only as the login
              (credentials + role + custom access) form. */}
          <Route path="employees"               element={<Gate><Employees /></Gate>} />
          <Route path="employees/new"           element={<Gate><EmployeeForm /></Gate>} />
          <Route path="employees/:id/edit"      element={<Gate><EmployeeForm /></Gate>} />
          <Route path="admin/users"             element={<Navigate to="/employees" replace />} />
          <Route path="admin/users/new"         element={<Gate><AdminUserForm /></Gate>} />
          <Route path="admin/users/:uid/edit"   element={<Gate><AdminUserForm /></Gate>} />
          <Route path="admin/cashiers"          element={<Navigate to="/employees" replace />} />
          <Route path="timeclock"             element={<Gate><TimeClock /></Gate>} />
          <Route path="account/referrals"     element={<Navigate to="/settings/referrals" replace />} />
          <Route path="account/tickets"      element={<Gate><SupportTickets /></Gate>} />
          {/* Legacy /account/profile — profile is now the first
              tab inside /settings (see the consolidation that
              moved the standalone page into Settings).  Keep a
              redirect for bookmarks + the rare deep link. */}
          <Route path="account/profile"       element={<Navigate to="/settings/profile" replace />} />
          <Route path="account/notifications" element={<Gate><AccountNotifications /></Gate>} />
          <Route path="account/activity"      element={<Gate><AccountActivity /></Gate>} />
          <Route path="account/sessions"      element={<Gate><AccountSessions /></Gate>} />
          <Route path="tv-display" element={<Gate><TVDisplayAdmin /></Gate>}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<Gate><TVDisplayOverview /></Gate>} />
            <Route path="content" element={<Gate><TVDisplayContent /></Gate>} />
            <Route path="device" element={<Gate><TVDisplayDevice /></Gate>} />
          </Route>
          <Route path="tv-display/countries/:countryId" element={<Gate><TVDisplayCountry /></Gate>} />
          <Route path="settings" element={<Settings />}>
            {/* Profile is the first tab — landing on /settings
                with no sub-path drops you into Profile so you
                see "your stuff" first, not the store-wide
                General tab.  /account/profile redirects here
                for back-compat. */}
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<Gate><SettingsProfile /></Gate>} />
            <Route path="general" element={<Gate><SettingsGeneral /></Gate>} />
            {/* Legacy /settings/team — cashier roster moved to
                /admin/cashiers when HR became its own sidebar
                section.  Keep a redirect for bookmarks. */}
            <Route path="team" element={<Navigate to="/employees" replace />} />
            <Route path="billing" element={<Gate><SettingsBilling /></Gate>} />
            <Route path="referrals" element={<Gate><SettingsReferrals /></Gate>} />
            <Route path="security" element={<Gate><SettingsSecurity /></Gate>} />
          </Route>
          {/* Authed catch-all keeps the AppShell chrome around the 404
              so a stray click doesn't make the user think they got
              signed out (the old top-level catch-all rendered NotFound
              outside the shell, which strips the sidebar + topbar). */}
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
    </RouteErrorBoundary>
  );
}

// Layout route. Bounces unauthed users to /login (RequireAuth)
// and wraps the authed page in the sidebar + topbar shell.
// `<Outlet />` renders the matched child route inside.
function AuthedShell() {
  const location = useLocation();
  return (
    <RequireAuth>
      <ToastProvider>
        <AppShell>
          <RouteErrorBoundary routeName="authed-route">
            {/* key={pathname} remounts the page on every route
                change, re-triggering the ds-page fade-up animation
                on the PageShell inside each route. The shell
                (sidebar + topbar) stays mounted. */}
            <div key={location.pathname}>
              <Outlet />
            </div>
          </RouteErrorBoundary>
        </AppShell>
      </ToastProvider>
    </RequireAuth>
  );
}

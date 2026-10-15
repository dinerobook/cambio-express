// What DineroBook does, module by module — the ONE copy of the
// product tour. The marketing page (/features) renders all of it
// as a grid; the sign-in page's features panel cycles through it.
//
// Every line is something the product does today. No invented
// customers, stats or quotes.

export interface ProductFeature {
  /** Short uppercase eyebrow, e.g. "LOTTERY". */
  eye: string;
  title: string;
  points: string[];
}

export const PRODUCT_FEATURES: ProductFeature[] = [
  {
    eye: "STORE DAILY BOOK",
    title: "Close the day from the register.",
    points: [
      "Import Gilbarco Passport journals — tickets, tenders, departments",
      "Register closes, over/short and deposits on one sheet",
      "Lock a day when it's done; every edit after is logged",
    ],
  },
  {
    eye: "TRANSACTIONS",
    title: "Every ticket, item by item.",
    points: [
      "Search any register ticket by time, cashier or item",
      "Voids and cancels kept, not hidden",
      "Item movement and department reports built from the same data",
    ],
  },
  {
    eye: "LOTTERY",
    title: "Packs, activations and day counts.",
    points: [
      "Receive, activate, settle and return packs",
      "Cashiers enter the day's counts; the book does the math",
      "Uncounted packs show on the dashboard until they're done",
    ],
  },
  {
    eye: "PRICE BOOK & PURCHASES",
    title: "Know your cost on every item.",
    points: [
      "Items, departments and vendors in one place",
      "Vendor invoices update item cost as they're entered",
      "Open invoices and what's owed, on the dashboard",
    ],
  },
  {
    eye: "MONEY TRANSFERS",
    title: "Every wire logged. Every sender remembered.",
    points: [
      "Intermex, Maxi, Barri, Ria, Western Union — one form",
      "Fee and federal tax separated correctly, every time",
      "Sender lookup shared across all your stores",
    ],
  },
  {
    eye: "ACH & RETURNED CHECKS",
    title: "Catch the variance the day it happens.",
    points: [
      "Match each ACH batch to the transfers behind it",
      "Track bounced checks and what's been recovered",
      "Rate board for the TV in your store, paired in a minute",
    ],
  },
  {
    eye: "MONTHLY P&L & REPORTS",
    title: "Know what you made last month.",
    points: [
      "P&L auto-filled from the daily books and transfer ledger",
      "Sales by company, employee, service and destination",
      "CSV export for your accountant; period comparison year over year",
    ],
  },
  {
    eye: "TEAM",
    title: "Everyone gets exactly the access they need.",
    points: [
      "Time clock with PIN or passkey punch, shift schedule, hours for payroll",
      "Access roles per job — a cashier never sees the P&L",
      "Owners see every store from one sign-in",
    ],
  },
];

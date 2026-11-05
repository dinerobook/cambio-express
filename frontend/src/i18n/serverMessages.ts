// Server error messages the translator knows (UI-STANDARDS §10).
//
// The API answers in English. Rather than change the shape of any
// live response, the SPA recognises the exact English sentences that
// covered screens can receive and shows the current language's words
// for them. Anything not listed shows the server's English as before.
//
// tests/Modules/Auth/test_spa_server_messages.py fails if a sentence
// listed here no longer appears in the API source, so a server-side
// rewording can't silently fall back to English.

import { getLanguage, t, type MessageKey } from "./index";

export const SERVER_MESSAGES: Record<string, MessageKey> = {
  "Invalid username or password": "login.invalidCredentials",
  "This store has been disabled. Contact support.": "login.storeDisabled",
  "Invalid verification code": "login.invalidVerificationCode",
  "Invalid recovery code": "login.invalidRecoveryCode",
  "Invalid or expired pending session": "login.sessionExpired",
  // Daily book
  "Amount must be greater than zero.": "daily.amountPositive",
  "Daily report is locked — unlock it before editing.": "daily.serverLocked",
  "No daily report logged for this date": "daily.serverNoReport",
  "Line item not found": "daily.serverEntryNotFound",
  "Lock failed": "daily.lockFailed",
  "Unlock failed": "daily.lockFailed",
  "Enter a valid time (HH:MM).": "daily.serverBadTime",
  "That's more than is still outstanding on this entry.": "daily.serverMoreThanOutstanding",
  "A return can't be dated before the entry it settles.": "daily.serverReturnBeforeEntry",
  "The settle-by date can't be before the entry's own day.": "daily.serverSettleByBeforeDay",
  "That entry isn't open for a return any more.": "daily.serverNotOpen",
  "Returns are recorded against this entry. Remove them first, then remove this entry.": "daily.serverHasReturns",
  "Returns already recorded against this entry add up to more than that amount.": "daily.serverReturnsExceed",
  "This payback is linked to a return check. Edit it from Books → Return Checks (update the payment).": "daily.serverPaybackEdit",
  "This payback is linked to a return check. Remove it from Books → Return Checks (delete the payment).": "daily.serverPaybackRemove",
  "A settle-by date needs the entry marked as coming back.": "daily.serverSettleByNeedsMark",
  "A return can't itself be marked as coming back.": "daily.serverReturnMarked",
  // Transfers
  "Transfer not found": "transfer.serverNotFound",
  "This store has business-hours enforcement on. Transfers can only be logged during the configured open hours — update them on /app/settings if this should be allowed.": "transfer.serverOutOfHours",
  "A payout is paid to the recipient in cash, so it can't be paid by debit card.": "transfer.serverPayoutCard",
  "A payout has no fee: the recipient is paid the full amount.": "transfer.serverPayoutFee",
  "An employee from the store roster must be selected as Processed by before saving.": "transfer.serverEmployeeRequired",
};

/** The server's `message` in the current language when known. A 429
 *  (rate limit) carries a library sentence, so it is matched by
 *  status instead. English always returns `message` unchanged. */
export function translateServerMessage(message: string, status?: number): string {
  if (getLanguage() === "en") return message;
  if (status === 429) return t("common.tooManyAttempts");
  const text = message.trim();
  return Object.hasOwn(SERVER_MESSAGES, text) ? t(SERVER_MESSAGES[text]) : message;
}

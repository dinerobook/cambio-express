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
};

/** The server's `message` in the current language when known. A 429
 *  (rate limit) carries a library sentence, so it is matched by
 *  status instead. English always returns `message` unchanged. */
export function translateServerMessage(message: string, status?: number): string {
  if (getLanguage() === "en") return message;
  if (status === 429) return t("common.tooManyAttempts");
  const key = SERVER_MESSAGES[message.trim()];
  return key ? t(key) : message;
}

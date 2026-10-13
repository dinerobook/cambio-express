// Tiny API client used by every SPA fetch. Wraps `fetch` so:
//   • ``credentials: "include"`` ships the httpOnly access-token
//     cookie automatically (PR #559 — see ``./auth.ts`` for the
//     cookie-vs-localStorage rationale).
//   • a 401 first attempts a silent refresh via ``/auth/refresh``
//     (PR #560 rotating refresh tokens). If that succeeds, retry
//     the original request once. If the refresh itself 401s the
//     session is dead — clear the local identity hint and bounce
//     to /app/login. Callers don't see the hop.
//   • non-2xx becomes a thrown ApiError with the parsed body.
//   • JSON request bodies get the right Content-Type.
//
// We intentionally don't import any HTTP library — `fetch` is
// browser-native, smaller bundle, and good enough for the SPA's
// needs. TanStack Query handles caching/retries on top.

import {
  clearAccessToken, clearRefreshFallback, getRefreshFallback,
  persistLoginResponse,
} from "./auth";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The server's message for a failed API call, or `fallback` for
 *  anything else (a network failure, a bug) — the one way to turn a
 *  caught error into text for an inline `<Alert>` or `<ErrorState>`.
 *  Toasts go through `useApiErrorToast`, which uses this.
 *
 *  `anyError: true` also surfaces a plain `Error`'s message — for a
 *  flow whose own code or browser API throws a sentence written for
 *  the person (WebAuthn cancel, push permission denied, Stripe.js
 *  connect, geolocation). Leave it off for a plain fetch: there a
 *  non-ApiError is "Failed to fetch" / a JSON parse error, and the
 *  fallback reads better. */
export function apiErrorMessage(
  err: unknown,
  fallback: string,
  { anyError = false }: { anyError?: boolean } = {},
): string {
  if (err instanceof ApiError) return err.message || fallback;
  if (anyError && err instanceof Error && err.message) return err.message;
  return fallback;
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  // JSON-serializable body. Use `null` (or omit) for GET/DELETE.
  json?: unknown;
}

// Single in-flight refresh promise — concurrent 401s from parallel
// requests (the SPA's first paint typically fires 3-4) get the
// same refresh round-trip rather than racing on the token.
let _inFlightRefresh: Promise<boolean> | null = null;

async function _silentRefresh(): Promise<boolean> {
  if (_inFlightRefresh) return _inFlightRefresh;
  _inFlightRefresh = (async () => {
    try {
      // PWA fallback: if the httpOnly cookie was cleared between
      // sessions (Chrome standalone windows do this), send the
      // refresh JTI from localStorage in the request body so the
      // server can find the token even without the cookie.
      const fallbackJti = getRefreshFallback();
      const resp = await fetch("/api/v2/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: fallbackJti
          ? { "Content-Type": "application/json" }
          : undefined,
        body: fallbackJti
          ? JSON.stringify({ refresh_token: fallbackJti })
          : undefined,
      });
      if (!resp.ok) return false;
      const body = await resp.json();
      if (
        typeof body === "object" && body &&
        typeof body.user_id === "number"
      ) {
        persistLoginResponse(body);
        // Owner store context: refresh re-mints the BASE owner
        // token (the server never persists switch state), so if
        // this device had entered a store, re-enter it now — the
        // retried request then runs store-scoped as before.
        if (body.role === "owner") {
          await _reenterOwnerStore();
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      _inFlightRefresh = null;
    }
  })();
  return _inFlightRefresh;
}

async function _reenterOwnerStore(): Promise<void> {
  let storeId: number | null = null;
  try {
    const raw = window.localStorage.getItem("db.owner_active_store");
    const id = raw != null ? Number(raw) : NaN;
    storeId = Number.isFinite(id) && id > 0 ? id : null;
  } catch { /* ignore */ }
  if (storeId == null) return;
  try {
    const resp = await fetch("/api/v2/auth/switch-store", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ store_id: storeId }),
    });
    if (resp.ok) {
      const body = await resp.json();
      if (typeof body === "object" && body
          && typeof body.user_id === "number") {
        persistLoginResponse(body);
      }
    } else if (resp.status === 403 || resp.status === 404) {
      // Store no longer switchable (unlinked / deactivated) —
      // stop trying on every refresh.
      window.localStorage.removeItem("db.owner_active_store");
    }
  } catch { /* base owner token still works; the chrome recovers */ }
}


// Where a 401 is the endpoint's answer, not a dead session.
//
// Sign-in steps: the person is not signed in yet (or holds only a
// pending 2FA token), so a 401 means "wrong password / code /
// recovery code". A refresh can't help, and bouncing to /app/login
// would throw away the pending token and the page's error message.
// No refresh, no bounce: the page shows the error.
const SIGN_IN_PATH = /^\/api\/v2\/auth\/login(?:-cross-store)?(?:[/?]|$)/;
// Time-clock punches: a failed passkey assertion or a punch from
// outside the geofence is a 401 too. The session itself may still
// have expired, so these refresh and retry once as usual; but if the
// retry still says 401 the session is alive and the punch was
// refused — show that, don't sign the employee out.
const PUNCH_PATH =
  /^\/api\/v2\/timeclock\/(?:clock-in|clock-out|break\/start|break\/stop|passkey\/challenge)(?:[/?]|$)/;

function _bounceToLogin(): void {
  clearAccessToken();
  clearRefreshFallback();
  const onLogin = window.location.pathname === "/app/login";
  if (!onLogin) window.location.assign("/app/login");
}

/** A fresh key for the ``Idempotency-Key`` header. A form makes one
 *  when it opens and sends it on every save attempt, so a retry after
 *  a dropped response or a server error that came after the save
 *  returns the row the first attempt created instead of a duplicate.
 *  ``crypto.randomUUID`` needs a secure context; plain http on a LAN
 *  falls back to ``getRandomValues``. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {},
  // Internal: prevents infinite recursion if the refresh itself
  // 401s. External callers always start with _retryAfterRefresh=true.
  _retryAfterRefresh = true,
): Promise<T> {
  const headers = new Headers(options.headers);

  const init: RequestInit = {
    ...options,
    headers,
    credentials: "include",  // ship the db_access_token httpOnly cookie
  };
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.json);
  }

  const resp = await fetch(path, init);

  // 204 No Content has no body — skip parsing entirely.
  if (resp.status === 204) return undefined as T;

  const ct = resp.headers.get("content-type") ?? "";
  const parsed = ct.includes("application/json")
    ? await resp.json()
    : await resp.text();

  if (!resp.ok) {
    if (resp.status === 401 && SIGN_IN_PATH.test(path)) {
      // Fall through to the ApiError below.
    } else if (resp.status === 401 && _retryAfterRefresh) {
      // Try a silent refresh. If it succeeds, retry the original
      // request exactly once (with retry disabled this time so a
      // second 401 doesn't loop forever).
      const refreshed = await _silentRefresh();
      if (refreshed) {
        return api<T>(path, options, /* _retryAfterRefresh = */ false);
      }
      _bounceToLogin();
    } else if (resp.status === 401 && !PUNCH_PATH.test(path)) {
      _bounceToLogin();
    } else if (
      resp.status === 403 && _retryAfterRefresh &&
      typeof parsed === "object" && parsed &&
      "detail" in parsed &&
      String((parsed as Record<string, unknown>).detail).startsWith("Missing permission")
    ) {
      const refreshed = await _silentRefresh();
      if (refreshed) {
        return api<T>(path, options, false);
      }
    }
    let message = `Request failed (${resp.status})`;
    if (typeof parsed === "object" && parsed && "detail" in parsed) {
      const detail = (parsed as Record<string, unknown>).detail;
      if (typeof detail === "string") {
        message = detail;
      } else if (
        detail &&
        typeof detail === "object" &&
        "message" in (detail as Record<string, unknown>)
      ) {
        // Field-level error envelope (e.g. /auth/change-password
        // returns {detail: {field, message}}).
        message = String(
          (detail as Record<string, unknown>).message,
        );
      }
    }
    throw new ApiError(resp.status, message, parsed);
  }
  return parsed as T;
}


// CSV downloads can't ride a plain <a href download> because the
// browser doesn't attach ``credentials`` on a top-level navigation
// the way it does on a fetch. Instead, fetch the bytes with the
// cookie attached (credentials: "include"), turn the response into
// a Blob, and trigger a download with a synthetic anchor click.
// Memory-bound, but report CSVs are tiny.
export async function downloadCsv(
  path: string,
  filename: string,
): Promise<void> {
  return downloadFile(path, { filename, failure: "CSV download failed" });
}

/** Any authenticated file download (CSV, ZIP, a JSON data export).
 *  Same 401 refresh as `api()`; a failure throws an `ApiError` so
 *  the caller can toast it. Without `filename` the server's
 *  Content-Disposition name is used, else `fallbackName`. */
export async function downloadFile(
  path: string,
  {
    filename, fallbackName = "download", failure = "Download failed",
  }: { filename?: string; fallbackName?: string; failure?: string } = {},
): Promise<void> {
  const tryFetch = () => fetch(path, { credentials: "include" });
  let resp = await tryFetch();
  if (resp.status === 401) {
    // Same silent-refresh dance as `api()`.
    const refreshed = await _silentRefresh();
    if (refreshed) {
      resp = await tryFetch();
    } else {
      _bounceToLogin();
    }
  }
  if (!resp.ok) {
    let body: unknown;
    try { body = await resp.json(); } catch { body = null; }
    throw new ApiError(resp.status, `${failure} (${resp.status})`, body);
  }
  const blob = await resp.blob();
  const served = /filename="([^"]+)"/
    .exec(resp.headers.get("content-disposition") ?? "")?.[1];
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? served ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

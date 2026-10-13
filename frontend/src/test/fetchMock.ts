// Route-level test helper: stub `fetch` with a table of canned
// responses so a page runs its REAL api hooks (react-query, error
// handling, ApiError messages) against the shapes the server sends.
//
//   const calls = mockFetch({
//     "GET /api/v2/timeclock/status": { body: { open_entries: [] } },
//     "POST /api/v2/timeclock/clock-in": { status: 422, body: { detail: "No." } },
//   });
//
// A key is "METHOD /path". The path matches the request's pathname
// exactly, or — when the key carries a `?` — the full path + query.
// A key ending in `*` matches any path with that prefix. A value may
// be a function of the request, to answer differently per call.
// Unmatched requests answer 599 so a test fails loudly instead of
// hanging on a pending query. The returned array records every call.
import { vi } from "vitest";

export interface MockRequest {
  method: string;
  path: string;
  url: URL;
  body: unknown;
}
export interface MockResponse {
  status?: number;
  body?: unknown;
}
export type MockHandler = MockResponse | ((req: MockRequest) => MockResponse);

function matches(key: string, req: MockRequest): boolean {
  const [method, pattern] = key.split(" ", 2);
  if (method !== req.method) return false;
  if (pattern.endsWith("*")) return req.path.startsWith(pattern.slice(0, -1));
  if (pattern.includes("?")) return req.path === pattern;
  return req.url.pathname === pattern;
}

export function mockFetch(routes: Record<string, MockHandler>): MockRequest[] {
  const calls: MockRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const req: MockRequest = { method, path: url.pathname + url.search, url, body };
    calls.push(req);
    const key = Object.keys(routes).find((k) => matches(k, req));
    const handler: MockHandler = key
      ? routes[key]
      : { status: 599, body: { detail: `unmocked ${method} ${req.path}` } };
    const res = typeof handler === "function" ? handler(req) : handler;
    const status = res.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(res.body ?? {}), {
      status, headers: { "content-type": "application/json" },
    });
  }));
  return calls;
}

/** The calls made to `METHOD path` (pathname match, query ignored). */
export function callsTo(calls: MockRequest[], key: string): MockRequest[] {
  const [method, pathname] = key.split(" ", 2);
  return calls.filter((c) => c.method === method && c.url.pathname === pathname);
}

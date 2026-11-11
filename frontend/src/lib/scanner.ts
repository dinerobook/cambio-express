// The check scanner, reached through the DineroBook Check Desk Windows
// app (desktop/windows). The app shows this site in a WebView2 window
// and talks to the MagTek Excella on the store PC; the page asks it
// through `window.chrome.webview` messages. In a plain browser there is
// no scanner and the cashier types the MICR line instead.
// Message contract: api/Modules/CheckCashing/INVARIANTS.md ("Scanner").

export type ScannerStatus = "ready" | "not_connected";

/** Why a scan gave nothing: the app's error codes. */
export type ScanErrorCode =
  | "not_connected" | "no_check" | "jam" | "busy" | "failed" | "no_app";

export interface ScanResult {
  /** The MICR line as the scanner read it. */
  raw: string;
  routing: string;
  account: string;
  number: string;
  /** Cents, when the check carries the amount field. */
  amountCents: number | null;
  /** Base64 JPEG pictures of the check's two sides, when taken. */
  front: string | null;
  back: string | null;
}

export class ScanError extends Error {
  readonly code: ScanErrorCode;
  constructor(code: ScanErrorCode, message = "") {
    super(message || code);
    this.code = code;
  }
}

interface WebViewBridge {
  postMessage(message: unknown): void;
  addEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", fn: (e: { data: unknown }) => void): void;
}

function bridge(): WebViewBridge | null {
  const w = window as unknown as { chrome?: { webview?: WebViewBridge } };
  return w.chrome?.webview ?? null;
}

/** True inside the Check Desk Windows app. */
export function inDesktopApp(): boolean {
  return bridge() != null;
}

interface Reply {
  type: "scanner.reply";
  id: number;
  ok: boolean;
  status?: ScannerStatus;
  error?: ScanErrorCode;
  message?: string;
  micr?: {
    raw?: string; routing?: string; account?: string; number?: string;
    amount_cents?: number | null;
  };
  front?: string | null;
  back?: string | null;
}

let nextId = 1;

/** Send one request to the app and wait for its reply. */
function ask(type: "scanner.status" | "scanner.scan", timeoutMs: number): Promise<Reply> {
  const wv = bridge();
  if (!wv) return Promise.reject(new ScanError("no_app"));
  const id = nextId++;
  return new Promise<Reply>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      wv.removeEventListener("message", onMessage);
      reject(new ScanError("no_check"));
    }, timeoutMs);
    function onMessage(e: { data: unknown }) {
      const reply = e.data as Reply | null;
      if (!reply || reply.type !== "scanner.reply" || reply.id !== id) return;
      window.clearTimeout(timer);
      wv?.removeEventListener("message", onMessage);
      resolve(reply);
    }
    wv.addEventListener("message", onMessage);
    wv.postMessage({ type, id });
  });
}

/** Whether the app sees the scanner. */
export async function scannerStatus(): Promise<ScannerStatus> {
  if (!bridge()) return "not_connected";
  try {
    const reply = await ask("scanner.status", 5_000);
    return reply.ok && reply.status === "ready" ? "ready" : "not_connected";
  } catch {
    return "not_connected";
  }
}

/** Get the scanner ready and wait for a check (the app gives up after a
 *  minute with ``no_check``). */
export async function scanCheck(): Promise<ScanResult> {
  const reply = await ask("scanner.scan", 90_000);
  if (!reply.ok) throw new ScanError(reply.error ?? "failed", reply.message);
  const m = reply.micr ?? {};
  return {
    raw: m.raw ?? "",
    routing: m.routing ?? "",
    account: m.account ?? "",
    number: m.number ?? "",
    amountCents: m.amount_cents ?? null,
    front: reply.front ?? null,
    back: reply.back ?? null,
  };
}

/** Tell the app to stop waiting for a check. */
export function cancelScan(): void {
  bridge()?.postMessage({ type: "scanner.cancel" });
}

import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckScanBar } from "./CheckScanBar";
import { setLanguage } from "../i18n";
import { englishLeftovers } from "../test/i18n";
import { renderRoute, signInAs } from "../test/renderRoute";

// How a check's numbers reach Cash a check (CheckCashing INVARIANTS
// "Scanner"): in the Check Desk Windows app the scanner is the default
// and Enter scans; without it the cashier types the MICR line.

type Msg = { type: string; id?: number };
type Answer = Record<string, unknown> | null;

/** Pretend to be the Windows app: ``answer`` replies to each request. */
function fakeApp(answer: (msg: Msg) => Answer) {
  const listeners = new Set<(e: { data: unknown }) => void>();
  const sent: Msg[] = [];
  (window as unknown as { chrome: unknown }).chrome = {
    webview: {
      postMessage(msg: Msg) {
        sent.push(msg);
        const reply = answer(msg);
        if (reply) {
          window.setTimeout(() => listeners.forEach((fn) => fn({
            data: { type: "scanner.reply", id: msg.id, ...reply },
          })), 0);
        }
      },
      addEventListener: (_: string, fn: (e: { data: unknown }) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { data: unknown }) => void) => listeners.delete(fn),
    },
  };
  return sent;
}

const READ = {
  ok: true,
  micr: {
    raw: "T111000025T 4400123456U 0232", routing: "111000025",
    account: "4400123456", number: "232", amount_cents: null,
  },
  front: "RlJPTlQ=", back: "QkFDSw==",
};

beforeEach(() => {
  signInAs({ permissions: ["check_cashing.read", "check_cashing.create"] });
});

afterEach(() => {
  delete (window as unknown as { chrome?: unknown }).chrome;
});

describe("without the scanner (a plain browser)", () => {
  it("fills the numbers from a typed MICR line on Enter", async () => {
    const onRead = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Scan check" })).not.toBeInTheDocument();
    const box = screen.getByRole("textbox", { name: "MICR line" });
    expect(box).toHaveFocus();
    await userEvent.type(box, "U010232U T111000025T 4400123456U{Enter}");
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({
      routing: "111000025", account: "4400123456", number: "10232",
      raw: "U010232U T111000025T 4400123456U",
    }));
    expect(screen.getByText(/Check read/)).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("says when the line has no routing number", async () => {
    const onRead = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "MICR line" }), "4400123456 232{Enter}");
    expect(onRead).not.toHaveBeenCalled();
    expect(screen.getByText(/No routing number found/)).toBeInTheDocument();
  });

  it("fills but warns when the routing number fails its check digit", async () => {
    const onRead = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox", { name: "MICR line" }), "T111000026T 4400123456U 232");
    await userEvent.click(screen.getByRole("button", { name: "Fill" }));
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ routing: "111000026" }));
    expect(screen.getByText(/fails its check digit/)).toBeInTheDocument();
  });
});

describe("in the Check Desk app with the scanner", () => {
  it("opens with Scan check focused and scans on Enter", async () => {
    const sent = fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" } : READ));
    const onRead = vi.fn();
    const onPictures = vi.fn(() => Promise.resolve());
    renderRoute(<CheckScanBar onRead={onRead} onPictures={onPictures} />);
    const button = await screen.findByRole("button", { name: "Scan check" });
    expect(button).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "MICR line" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(expect.objectContaining({
      routing: "111000025", account: "4400123456", number: "232",
      raw: "T111000025T 4400123456U 0232",
    })));
    expect(onPictures).toHaveBeenCalledWith("RlJPTlQ=", "QkFDSw==");
    expect(sent.map((m) => m.type)).toEqual(["scanner.status", "scanner.scan"]);
    expect(await screen.findByText(/Check read/)).toBeInTheDocument();
  });

  it("scans on Enter when nothing on the page has the focus", async () => {
    const sent = fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" } : null));
    renderRoute(<CheckScanBar onRead={vi.fn()} onPictures={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "Scan check" });
    act(() => button.blur());
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByText("Put the check in the scanner…")).toBeInTheDocument();
    expect(sent.at(-1)?.type).toBe("scanner.scan");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(sent.at(-1)?.type).toBe("scanner.cancel");
  });

  it("parses the raw line when the app sends no fields", async () => {
    fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" }
      : { ok: true, micr: { raw: "U010232U T111000025T 4400123456U" } }));
    const onRead = vi.fn();
    const onPictures = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={onPictures} />);
    await userEvent.click(await screen.findByRole("button", { name: "Scan check" }));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(expect.objectContaining({
      routing: "111000025", number: "10232",
    })));
    expect(onPictures).not.toHaveBeenCalled();
  });

  it("says why a scan gave nothing", async () => {
    fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" }
      : { ok: false, error: "jam" }));
    const onRead = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Scan check" }));
    expect(await screen.findByText(/stuck in the scanner/)).toBeInTheDocument();
    expect(onRead).not.toHaveBeenCalled();
  });

  it("says when the pictures could not be saved", async () => {
    fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" } : READ));
    renderRoute(<CheckScanBar onRead={vi.fn()} onPictures={() => Promise.reject(new Error("x"))} />);
    await userEvent.click(await screen.findByRole("button", { name: "Scan check" }));
    expect(await screen.findByText(/pictures couldn't be saved/)).toBeInTheDocument();
  });

  it("falls back to the MICR line when the scanner is unplugged", async () => {
    const sent = fakeApp(() => ({ ok: true, status: "not_connected" }));
    const onRead = vi.fn();
    renderRoute(<CheckScanBar onRead={onRead} onPictures={vi.fn()} />);
    expect(await screen.findByText(/Scanner not connected/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scan check" })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "MICR line" }), "111000025 4400123456 232{Enter}");
    expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ routing: "111000025" }));
    await userEvent.click(screen.getByRole("button", { name: "Look for the scanner again" }));
    expect(sent.filter((m) => m.type === "scanner.status")).toHaveLength(2);
  });

  it("goes back to the MICR line when a scan finds the scanner gone", async () => {
    fakeApp((m) => (m.type === "scanner.status" ? { ok: true, status: "ready" }
      : { ok: false, error: "not_connected" }));
    renderRoute(<CheckScanBar onRead={vi.fn()} onPictures={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Scan check" }));
    expect(await screen.findByRole("textbox", { name: "MICR line" })).toBeInTheDocument();
  });

  it("is in Spanish", async () => {
    setLanguage("es");
    fakeApp(() => ({ ok: true, status: "ready" }));
    renderRoute(<CheckScanBar onRead={vi.fn()} onPictures={vi.fn()} />);
    await screen.findByRole("button", { name: "Escanear cheque" });
    expect(englishLeftovers(document.body, ["checkCashing."])).toEqual([]);
  });
});

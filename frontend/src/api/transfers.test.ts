import { afterEach, describe, expect, it, vi } from "vitest";

import { createTransfer, previewFederalTax } from "./transfers";
import { newIdempotencyKey } from "../lib/api";

// createTransfer carries the form's save key as the Idempotency-Key
// header, so the server can answer a repeat save with the transfer it
// already created (a 500 after the commit once logged one transfer 8
// times at a live store).

const BODY = {
  send_date: "2026-10-12", company: "Intermex", service_type: "Money Transfer",
  sender_name: "A", send_amount: 1,
};

function okFetch() {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ transfer: { id: 5 } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTransfer", () => {
  it("sends the save key as the Idempotency-Key header", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await createTransfer(BODY, "key-123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("key-123");
  });

  it("sends no Idempotency-Key when the caller has none", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    await createTransfer(BODY);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false);
  });
});

describe("newIdempotencyKey", () => {
  it("makes a different key every call", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it("falls back to random hex where randomUUID is missing (plain http)", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (a: Uint8Array) => a.fill(171),
    });
    const key = newIdempotencyKey();
    expect(key).toBe("ab".repeat(16));
    expect(key.length).toBeLessThanOrEqual(64);  // server's max_length
  });
});

// Mirrors federal_tax_for(): since 2026-01-01 the 1% remittance tax is
// on cash sends only, so a debit card send previews $0.00.
describe("previewFederalTax", () => {
  const base = {
    sendAmount: 200, serviceType: "Money Transfer", country: "Mexico", rate: 0.01,
  };

  it("taxes a cash send", () => {
    expect(previewFederalTax({ ...base, paymentMethod: "cash" })).toBe(2);
  });

  it("taxes a send with no payment method (reads as cash)", () => {
    expect(previewFederalTax(base)).toBe(2);
    expect(previewFederalTax({ ...base, paymentMethod: null })).toBe(2);
  });

  it("does not tax a debit card send", () => {
    expect(previewFederalTax({ ...base, paymentMethod: "debit_card" })).toBe(0);
  });

  it("keeps the other exemptions", () => {
    expect(previewFederalTax({ ...base, country: "United States" })).toBe(0);
    expect(previewFederalTax({ ...base, serviceType: "Payout" })).toBe(0);
    expect(previewFederalTax({ ...base, rate: 0 })).toBe(0);
  });
});

import { describe, expect, it } from "vitest";

import { BATCH_STATUS_TONES } from "./batches";
import { RETURN_CHECK_STATUS_TONES } from "./returnChecks";
import { TRANSFER_STATUS_TONES } from "./transfers";

// UI-STANDARDS §3: a status gets ONE tone on every screen. These
// maps are the single source; the Dashboard, Batches, Return
// checks list and Return check form all read them. Before they
// were shared, the Dashboard showed a cleared batch in the live
// "accent" tone while the Batches page showed it as "success".

describe("status tone maps", () => {
  it("batch: a completed outcome is success, a failure is negative", () => {
    expect(BATCH_STATUS_TONES).toEqual({
      Pending: "warning",
      Cleared: "success",
      Returned: "negative",
      Held: "info",
    });
  });

  it("transfer: Sent is the completed happy path, not live accent", () => {
    expect(TRANSFER_STATUS_TONES).toEqual({
      Sent: "success",
      Pending: "warning",
      Cancelled: "negative",
      Returned: "negative",
    });
  });

  it("return check: recovered is success, loss and fraud are negative", () => {
    expect(RETURN_CHECK_STATUS_TONES).toEqual({
      pending: "warning",
      recovered: "success",
      loss: "negative",
      fraud: "negative",
    });
  });

  it("no map uses accent, which is reserved for live state", () => {
    for (const map of [
      BATCH_STATUS_TONES, TRANSFER_STATUS_TONES, RETURN_CHECK_STATUS_TONES,
    ]) {
      expect(Object.values(map)).not.toContain("accent");
    }
  });
});

import { describe, expect, it } from "vitest";

import { ANNOUNCEMENT_LEVEL_TONES } from "./announcements";
import { BATCH_STATUS_TONES } from "./batches";
import { PLAN_TONES, planTone } from "./billing";
import { PACK_STATUS_TONES } from "./lottery";
import { ROLE_TONES, roleTone } from "./roles";
import { EMAIL_EVENT_TONES } from "./superadmin";
import { TIMECLOCK_STATUS_TONES } from "./timeclock";
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

  it("role: the UI-STANDARDS role pills, and no platform role is red", () => {
    // Six routes used to spell this out; SuperadminUsers painted
    // superadmin red, which §3 reserves for failures.
    expect(ROLE_TONES).toEqual({
      admin: "accent",
      employee: "neutral",
      owner: "info",
      superadmin: "warning",
      support: "info",
    });
    expect(Object.values(ROLE_TONES)).not.toContain("negative");
    expect(roleTone("admin")).toBe("accent");
    expect(roleTone("custom-role")).toBe("neutral");
  });

  it("plan: paying is live, trial is expiring, inactive is off (not red)", () => {
    // SuperadminStores showed inactive red and basic as success while
    // the store drill-down showed an unknown plan red.
    expect(PLAN_TONES).toEqual({
      trial: "warning",
      basic: "accent",
      pro: "accent",
      inactive: "neutral",
    });
    expect(planTone("inactive")).toBe("neutral");
    expect(planTone("legacy")).toBe("neutral");
  });

  it("time clock: approved is success on the history and the paystub", () => {
    // The paystub coloured approved in the live accent.
    expect(TIMECLOCK_STATUS_TONES).toEqual({
      pending: "warning",
      approved: "success",
      rejected: "negative",
    });
  });

  it("lottery pack: on sale is the live state", () => {
    expect(PACK_STATUS_TONES).toEqual({
      received: "neutral",
      active: "accent",
      settled: "success",
      returned: "warning",
    });
  });

  it("announcement level: error is negative, the rest map by name", () => {
    expect(ANNOUNCEMENT_LEVEL_TONES).toEqual({
      info: "info",
      warning: "warning",
      error: "negative",
      success: "success",
    });
  });

  it("email event: delivered / opened / clicked are outcomes, not live", () => {
    expect(EMAIL_EVENT_TONES).toEqual({
      "email.sent": "neutral",
      "email.delivered": "success",
      "email.opened": "success",
      "email.clicked": "success",
      "email.delivery_delayed": "warning",
      "email.bounced": "negative",
      "email.complained": "negative",
    });
  });

  it("no map uses accent, which is reserved for live state", () => {
    for (const map of [
      BATCH_STATUS_TONES, TRANSFER_STATUS_TONES, RETURN_CHECK_STATUS_TONES,
      TIMECLOCK_STATUS_TONES, ANNOUNCEMENT_LEVEL_TONES, EMAIL_EVENT_TONES,
    ]) {
      expect(Object.values(map)).not.toContain("accent");
    }
  });

  it("accent only ever marks a live state", () => {
    // Maps that do use accent: only for a state that is on right now.
    const live = new Set(["admin", "basic", "pro", "active"]);
    for (const map of [ROLE_TONES, PLAN_TONES, PACK_STATUS_TONES]) {
      for (const [key, tone] of Object.entries(map)) {
        if (tone === "accent") expect(live).toContain(key);
      }
    }
  });
});

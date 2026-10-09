import { describe, expect, it } from "vitest";

import { actionsFor, toggleMatrixCell } from "./permissions";

describe("toggleMatrixCell", () => {
  const none = { create: false, read: false, update: false, delete: false };

  it("ticking a write also ticks View", () => {
    expect(toggleMatrixCell(none, "update")).toEqual(
      { create: false, read: true, update: true, delete: false },
    );
  });

  it("unticking View clears every write", () => {
    const all = { create: true, read: true, update: true, delete: true };
    expect(toggleMatrixCell(all, "read")).toEqual(none);
  });

  it("unticking a write leaves View alone", () => {
    const row = { create: false, read: true, update: true, delete: false };
    expect(toggleMatrixCell(row, "update")).toEqual(
      { create: false, read: true, update: false, delete: false },
    );
  });

  it("handles a row that is not there yet", () => {
    expect(toggleMatrixCell(undefined, "create")).toEqual(
      { create: true, read: true },
    );
  });
});

describe("single-switch resources", () => {
  const none = { create: false, read: false, update: false, delete: false };
  const ALL = ["create", "read", "update", "delete"];

  it("Lock / unlock days has only its one action", () => {
    expect(actionsFor("day_lock", ALL)).toEqual(["update"]);
    expect(actionsFor("daily_book", ALL)).toEqual(ALL);
  });

  it("ticking the switch does not imply View", () => {
    expect(toggleMatrixCell(none, "update", "day_lock")).toEqual(
      { ...none, update: true },
    );
    expect(
      toggleMatrixCell({ ...none, update: true }, "update", "day_lock"),
    ).toEqual(none);
  });

  it("an ordinary area still couples View", () => {
    expect(toggleMatrixCell(none, "update", "daily_book")).toEqual(
      { ...none, read: true, update: true },
    );
  });
});

import { describe, expect, it } from "vitest";

import { toggleMatrixCell } from "./permissions";

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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PAGE_SIZE, pageOf, pageRange, readPageSize, sortRows, writePageSize,
} from "./pagination";

// The shared paging helpers: remembered rows-per-page (safe when
// storage is blocked), the "Showing a–b of N" range, and the
// browser-side page / sort for lists the server sends whole.

describe("page size memory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("db.page_size.t");
  });

  it("defaults, remembers a choice, and ignores junk", () => {
    expect(readPageSize("t")).toBe(DEFAULT_PAGE_SIZE);
    writePageSize("t", 100);
    expect(readPageSize("t")).toBe(100);
    localStorage.setItem("db.page_size.t", "7");
    expect(readPageSize("t")).toBe(DEFAULT_PAGE_SIZE);
  });

  it("falls back to the default when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => writePageSize("t", 25)).not.toThrow();
    expect(readPageSize("t")).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("pageRange", () => {
  it("covers first, middle and last pages", () => {
    expect(pageRange(1, 3, 120, 50)).toEqual([1, 50]);
    expect(pageRange(2, 3, 120, 50)).toEqual([51, 100]);
    expect(pageRange(3, 3, 120, 20)).toEqual([101, 120]);
    expect(pageRange(1, 1, 0, 0)).toEqual([0, 0]);
  });
});

describe("pageOf", () => {
  const rows = Array.from({ length: 60 }, (_, i) => i + 1);

  it("slices one page and reports the envelope", () => {
    expect(pageOf(rows, 2, 25)).toEqual({
      rows: rows.slice(25, 50), page: 2, totalPages: 3, total: 60,
    });
  });

  it("clamps a page past the end and an empty list", () => {
    expect(pageOf(rows, 9, 25).page).toBe(3);
    expect(pageOf(rows, 9, 25).rows).toEqual(rows.slice(50));
    expect(pageOf([], 4, 25)).toEqual({ rows: [], page: 1, totalPages: 1, total: 0 });
  });
});

describe("sortRows", () => {
  const people = [
    { name: "bea", rate: 15 }, { name: "Ana", rate: 9 }, { name: "carl", rate: 20 },
  ];
  const keys = { name: (p: typeof people[0]) => p.name, rate: (p: typeof people[0]) => p.rate };

  it("sorts text ignoring case, both ways", () => {
    expect(sortRows(people, keys, "name", "asc").map((p) => p.name)).toEqual(["Ana", "bea", "carl"]);
    expect(sortRows(people, keys, "name", "desc").map((p) => p.name)).toEqual(["carl", "bea", "Ana"]);
  });

  it("sorts numbers as numbers", () => {
    expect(sortRows(people, keys, "rate", "desc").map((p) => p.rate)).toEqual([20, 15, 9]);
  });

  it("keeps the given order for an unknown key and never mutates", () => {
    const copy = [...people];
    expect(sortRows(people, keys, "nope")).toEqual(people);
    sortRows(people, keys, "name");
    expect(people).toEqual(copy);
  });
});

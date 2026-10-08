import { describe, expect, it } from "vitest";

import { allTicketsQueryString } from "./support";

// The ticket queue's filters become one query string. Pinning the
// rules here keeps the page from refetching on a single keystroke
// (the server ignores a search under 2 characters anyway) and from
// sending a page=1 the server already defaults to.
describe("allTicketsQueryString", () => {
  it("is empty with no filters", () => {
    expect(allTicketsQueryString({})).toBe("");
    expect(allTicketsQueryString({ q: "", status: "", page: 1 })).toBe("");
  });

  it("drops a search under two characters and trims the rest", () => {
    expect(allTicketsQueryString({ q: "m" })).toBe("");
    expect(allTicketsQueryString({ q: "  " })).toBe("");
    expect(allTicketsQueryString({ q: " maria " })).toBe("?q=maria");
  });

  it("carries status, category, store and page past 1", () => {
    expect(allTicketsQueryString({
      status: "open", category: "bug", store_id: 7, page: 3,
    })).toBe("?status=open&category=bug&store_id=7&page=3");
    expect(allTicketsQueryString({ store_id: "12" })).toBe("?store_id=12");
    expect(allTicketsQueryString({ page: 1 })).toBe("");
  });
});

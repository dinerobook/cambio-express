import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import { useUrlFilterState } from "./useUrlFilterState";

function wrapper(initial: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
}

describe("useUrlFilterState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads initial values from URL", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "", status: "" }),
      { wrapper: wrapper("/?q=hello&status=active&page=3") },
    );
    expect(result.current.params.q).toBe("hello");
    expect(result.current.params.status).toBe("active");
    expect(result.current.page).toBe(3);
  });

  it("falls back to defaults when URL is empty", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "", status: "all" }),
      { wrapper: wrapper("/") },
    );
    expect(result.current.params.q).toBe("");
    expect(result.current.params.status).toBe("all");
    expect(result.current.page).toBe(1);
  });

  it("setParam resets page to 1", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/?q=foo&page=5") },
    );
    expect(result.current.page).toBe(5);
    act(() => {
      result.current.setParam("q", "bar");
    });
    expect(result.current.params.q).toBe("bar");
    expect(result.current.page).toBe(1);
  });

  it("setParam clears the key when value is empty", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/?q=foo") },
    );
    act(() => {
      result.current.setParam("q", "");
    });
    expect(result.current.params.q).toBe("");
  });

  it("setPage keeps other params intact", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/?q=foo&page=1") },
    );
    act(() => {
      result.current.setPage(4);
    });
    expect(result.current.page).toBe(4);
    expect(result.current.params.q).toBe("foo");
  });

  it("debounced writes after 300ms by default", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/") },
    );
    act(() => {
      result.current.debounced("q", "search");
    });
    expect(result.current.draft.q).toBe("search");
    expect(result.current.params.q).toBe("");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.q).toBe("search");
  });

  it("debounced respects 2-char minimum", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/") },
    );
    act(() => {
      result.current.debounced("q", "a");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.q).toBe("");
  });

  it("debounced allows clearing with empty string", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/?q=existing") },
    );
    act(() => {
      result.current.debounced("q", "");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.q).toBe("");
  });

  it("debounced cancels previous timer if called again", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }),
      { wrapper: wrapper("/") },
    );
    act(() => {
      result.current.debounced("q", "first");
    });
    act(() => {
      vi.advanceTimersByTime(200);
      result.current.debounced("q", "second");
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.params.q).toBe("");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.params.q).toBe("second");
  });

  it("reset clears all params", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "", status: "" }),
      { wrapper: wrapper("/?q=foo&status=bar&page=3") },
    );
    act(() => {
      result.current.reset();
    });
    expect(result.current.params.q).toBe("");
    expect(result.current.params.status).toBe("");
    expect(result.current.page).toBe(1);
  });

  it("supports custom debounce window", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }, { debounceMs: 500 }),
      { wrapper: wrapper("/") },
    );
    act(() => {
      result.current.debounced("q", "hi");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.q).toBe("");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.params.q).toBe("hi");
  });

  it("supports custom minLength", () => {
    const { result } = renderHook(
      () => useUrlFilterState({ q: "" }, { minLength: 1 }),
      { wrapper: wrapper("/") },
    );
    act(() => {
      result.current.debounced("q", "a");
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.params.q).toBe("a");
  });

  describe("rows per page", () => {
    beforeEach(() => window.localStorage.clear());

    it("defaults to 50", () => {
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "things" }),
        { wrapper: wrapper("/") },
      );
      expect(result.current.perPage).toBe(50);
    });

    it("remembers the choice per list and returns to page 1", () => {
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "things" }),
        { wrapper: wrapper("/?page=4") },
      );
      act(() => result.current.setPerPage(100));
      expect(result.current.perPage).toBe(100);
      expect(result.current.page).toBe(1);
      expect(window.localStorage.getItem("db.page_size.things")).toBe("100");

      const other = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "others" }),
        { wrapper: wrapper("/") },
      );
      expect(other.result.current.perPage).toBe(50);
      const again = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "things" }),
        { wrapper: wrapper("/") },
      );
      expect(again.result.current.perPage).toBe(100);
    });

    it("ignores a stored value that is not a choice", () => {
      window.localStorage.setItem("db.page_size.things", "7");
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "things" }),
        { wrapper: wrapper("/") },
      );
      expect(result.current.perPage).toBe(50);
    });

    it("still works when browser storage is blocked", () => {
      const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { pageSizeKey: "things" }),
        { wrapper: wrapper("/") },
      );
      expect(result.current.perPage).toBe(50);
      act(() => result.current.setPerPage(25));
      expect(result.current.perPage).toBe(25);
      get.mockRestore();
      set.mockRestore();
    });
  });

  describe("sort", () => {
    it("is off unless a default sort is given", () => {
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }),
        { wrapper: wrapper("/?sort=name") },
      );
      expect(result.current.sort).toBeUndefined();
    });

    it("reads the URL, falling back to the default", () => {
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { defaultSort: { key: "date", direction: "desc" } }),
        { wrapper: wrapper("/?sort=name&dir=bogus") },
      );
      expect(result.current.sort).toMatchObject({ key: "name", direction: "desc" });
    });

    it("writes sort and direction together and returns to page 1", () => {
      const { result } = renderHook(
        () => useUrlFilterState({ q: "" }, { defaultSort: { key: "date", direction: "desc" } }),
        { wrapper: wrapper("/?q=ab&page=3") },
      );
      act(() => result.current.sort!.onSort("amount", "asc"));
      expect(result.current.sort).toMatchObject({ key: "amount", direction: "asc" });
      expect(result.current.page).toBe(1);
      expect(result.current.params.q).toBe("ab");
    });
  });
});

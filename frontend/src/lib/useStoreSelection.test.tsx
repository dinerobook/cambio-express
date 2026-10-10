import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useStoreSelection } from "./useStoreSelection";

describe("useStoreSelection", () => {
  it("toggles one store on and off, in click order", () => {
    const { result } = renderHook(() => useStoreSelection([1, 2, 3]));
    act(() => result.current.toggle(3));
    act(() => result.current.toggle(1));
    expect(result.current.selected).toEqual([3, 1]);
    expect(result.current.isSelected(1)).toBe(true);
    expect(result.current.isSelected(2)).toBe(false);
    act(() => result.current.toggle(3));
    expect(result.current.selected).toEqual([1]);
    expect(result.current.allSelected).toBe(false);
  });

  it("select all, then clear all", () => {
    const { result } = renderHook(() => useStoreSelection([1, 2, 3]));
    act(() => result.current.toggle(2));
    act(() => result.current.toggleAll());
    expect(result.current.selected).toEqual([1, 2, 3]);
    expect(result.current.allSelected).toBe(true);
    act(() => result.current.toggleAll());
    expect(result.current.selected).toEqual([]);
  });

  it("an empty umbrella is never 'all selected'", () => {
    const { result } = renderHook(() => useStoreSelection([]));
    expect(result.current.allSelected).toBe(false);
  });
});

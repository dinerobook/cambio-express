import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { StoreChecklist } from "./StoreChecklist";
import { useStoreSelection } from "../lib/useStoreSelection";

// The owner bulk tools' one "Apply to" store list (Add user to
// stores, Cross-store defaults, Bulk permissions).

const STORES = [
  { store_id: 1, store_name: "Main St", store_slug: "main-st" },
  { store_id: 2, store_name: "Second St", store_slug: "second-st" },
];

function Harness() {
  const selection = useStoreSelection(STORES.map((s) => s.store_id));
  return <StoreChecklist stores={STORES} selection={selection} />;
}

describe("<StoreChecklist>", () => {
  it("ticks stores one by one and shows how many are picked", async () => {
    render(<Harness />);
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Main St/ }));
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();
    expect(screen.getByText("main-st")).toBeInTheDocument();
  });

  it("selects and clears every store at once", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox").every((c) => (c as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();
  });

  it("leaves out the slug when a list has none", () => {
    const { result } = renderHook(() => useStoreSelection([1]));
    act(() => result.current.toggle(1));
    render(<StoreChecklist stores={[{ store_id: 1, store_name: "Solo" }]} selection={result.current} />);
    expect(screen.getByRole("checkbox", { name: "Solo" })).toBeChecked();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginShowcase, SHOWCASE_INTERVAL_MS } from "./LoginShowcase";
import { PRODUCT_FEATURES } from "../lib/productFeatures";

// The features half of the sign-in page: one module at a time from
// the shared PRODUCT_FEATURES list, advancing on its own, pausing
// while hovered, never moving for reduced-motion users, and linking
// to the full features page and to sign-up.

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("prefers-reduced-motion"),
    media: q, addEventListener() {}, removeEventListener() {},
  }));
}

function renderPanel() {
  return render(<MemoryRouter><LoginShowcase /></MemoryRouter>);
}

const [first, second, third] = PRODUCT_FEATURES;

describe("LoginShowcase", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubReducedMotion(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens on the first feature with all its points", () => {
    renderPanel();
    expect(screen.getByText(first.title)).toBeInTheDocument();
    for (const p of first.points) expect(screen.getByText(p)).toBeInTheDocument();
    expect(screen.queryByText(second.title)).not.toBeInTheDocument();
  });

  it("moves to the next feature on its own and wraps round", () => {
    renderPanel();
    act(() => { vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS); });
    expect(screen.getByText(second.title)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS * (PRODUCT_FEATURES.length - 1));
    });
    expect(screen.getByText(first.title)).toBeInTheDocument();
  });

  it("has one dot per feature and a dot jumps to its feature", () => {
    renderPanel();
    const dots = screen.getAllByRole("button", { name: /^Show / });
    expect(dots).toHaveLength(PRODUCT_FEATURES.length);
    expect(dots[0]).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(dots[2]);
    expect(screen.getByText(third.title)).toBeInTheDocument();
    expect(dots[2]).toHaveAttribute("aria-pressed", "true");
    expect(dots[0]).toHaveAttribute("aria-pressed", "false");
  });

  it("holds still while the pointer is over it and resumes after", () => {
    renderPanel();
    const panel = screen.getByRole("region", { name: /does$/ });
    fireEvent.mouseEnter(panel);
    act(() => { vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS * 3); });
    expect(screen.getByText(first.title)).toBeInTheDocument();
    fireEvent.mouseLeave(panel);
    act(() => { vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS); });
    expect(screen.getByText(second.title)).toBeInTheDocument();
  });

  it("never advances for someone who asked for reduced motion", () => {
    stubReducedMotion(true);
    renderPanel();
    act(() => { vi.advanceTimersByTime(SHOWCASE_INTERVAL_MS * 3); });
    expect(screen.getByText(first.title)).toBeInTheDocument();
    // The dots still work by hand.
    fireEvent.click(screen.getAllByRole("button", { name: /^Show / })[1]);
    expect(screen.getByText(second.title)).toBeInTheDocument();
  });

  it("links to the full features page and to sign-up", () => {
    renderPanel();
    expect(screen.getByRole("link", { name: /See everything/ }))
      .toHaveAttribute("href", "/features");
    expect(screen.getByRole("link", { name: /free trial/ }))
      .toHaveAttribute("href", "/signup");
  });
});

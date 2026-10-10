import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PeriodStepper } from "./PeriodStepper";

// The shared prev / [middle] / next control. Covers the accessible
// names (from `unit`, never the arrow glyph), the callbacks, the
// disabled bounds, the optional today / calendar buttons and the
// ← / → key binding with its "not while typing" rule.

describe("<PeriodStepper>", () => {
  it("names its buttons by unit and renders the middle", () => {
    render(
      <PeriodStepper unit="month" onPrev={() => {}} onNext={() => {}}>
        <span>October 2026</span>
      </PeriodStepper>,
    );
    expect(screen.getByRole("button", { name: "Previous month" })).toHaveTextContent("←");
    expect(screen.getByRole("button", { name: "Next month" })).toHaveTextContent("→");
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    // No today / calendar buttons unless asked for.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("fires onPrev / onNext", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<PeriodStepper unit="day" onPrev={onPrev} onNext={onNext} />);
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it("disables a bound and does not fire it", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(
      <PeriodStepper unit="month" onPrev={() => {}} onNext={onNext} nextDisabled />,
    );
    const next = screen.getByRole("button", { name: "Next month" });
    expect(next).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeEnabled();
    await user.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it("labeled variant spells the period out, with a today button", async () => {
    const user = userEvent.setup();
    const onToday = vi.fn();
    render(
      <PeriodStepper
        unit="week" variant="labeled"
        onPrev={() => {}} onNext={() => {}}
        onToday={onToday} todayLabel="This week"
      />,
    );
    expect(screen.getByRole("button", { name: "Previous week" }))
      .toHaveTextContent("← Previous week");
    expect(screen.getByRole("button", { name: "Next week" }))
      .toHaveTextContent("Next week →");
    await user.click(screen.getByRole("button", { name: "This week" }));
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("chevrons variant renders icon buttons and the calendar shortcut", async () => {
    const user = userEvent.setup();
    const onCalendar = vi.fn();
    render(
      <PeriodStepper
        unit="day" variant="chevrons"
        onPrev={() => {}} onNext={() => {}} onCalendar={onCalendar}
      />,
    );
    const prev = screen.getByRole("button", { name: "Previous day" });
    expect(prev.querySelector("svg")).not.toBeNull();
    expect(prev).toHaveAttribute("title", "Previous day");
    await user.click(screen.getByRole("button", { name: "Back to calendar" }));
    expect(onCalendar).toHaveBeenCalledTimes(1);
  });

  describe("arrow keys", () => {
    function setup(extra: Partial<Parameters<typeof PeriodStepper>[0]> = {}) {
      const onPrev = vi.fn();
      const onNext = vi.fn();
      const view = render(
        <>
          <input aria-label="Amount" />
          <PeriodStepper
            unit="day" variant="chevrons" arrowKeys
            onPrev={onPrev} onNext={onNext} {...extra}
          />
        </>,
      );
      return { onPrev, onNext, ...view };
    }

    it("← / → step the period and the titles say so", () => {
      const { onPrev, onNext } = setup();
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onPrev).toHaveBeenCalledTimes(1);
      expect(onNext).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Previous day" }))
        .toHaveAttribute("title", "Previous day (←)");
    });

    it("leaves keys alone while typing in a field and with modifiers", () => {
      const { onPrev, onNext } = setup();
      screen.getByLabelText("Amount").focus();
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true });
      fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
      expect(onPrev).not.toHaveBeenCalled();
      expect(onNext).not.toHaveBeenCalled();
    });

    it("honours the disabled bounds", () => {
      const { onPrev, onNext } = setup({ prevDisabled: true });
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onPrev).not.toHaveBeenCalled();
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it("is not bound unless asked for, and unbinds on unmount", () => {
      const onNext = vi.fn();
      const { unmount } = render(
        <PeriodStepper unit="day" onPrev={() => {}} onNext={onNext} />,
      );
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onNext).not.toHaveBeenCalled();
      unmount();

      const bound = setup();
      bound.unmount();
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(bound.onNext).not.toHaveBeenCalled();
    });
  });
});

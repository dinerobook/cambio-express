import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangePicker } from "./DateRangePicker";
import type { IsoRange } from "../../lib/dateRanges";
import { setLanguage } from "../../i18n";

// The shared date range picker (UI-STANDARDS §4 "Date ranges"):
//   - the trigger names the preset the range is, else the two days;
//   - a preset applies at once, counted from the store's day;
//   - a custom range needs both days, then "Apply"; Cancel keeps it;
//   - Spanish.

const TODAY = "2026-11-27";

function Harness({ initial, onChange }: { initial: IsoRange; onChange: (r: IsoRange) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DateRangePicker
      value={value} today={TODAY} aria-label="Period"
      onChange={(r) => { setValue(r); onChange(r); }}
    />
  );
}

afterEach(() => setLanguage("en"));

describe("DateRangePicker", () => {
  it("names a preset, else the two days", () => {
    const { unmount } = render(
      <Harness initial={{ from: "2026-11-01", to: "2026-11-30" }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /^Period:/ })).toHaveTextContent("This month");
    unmount();
    render(<Harness initial={{ from: "2026-11-03", to: "2026-11-12" }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Period:/ }))
      .toHaveTextContent("Nov 3, 2026 – Nov 12, 2026");
  });

  it("applies a preset at once", async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: "2026-11-01", to: "2026-11-30" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Period:/ }));
    const presets = screen.getByRole("list", { name: "Periods" });
    expect(within(presets).getByRole("button", { name: "This month" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(presets).getByRole("button", { name: "Last quarter" }));
    expect(onChange).toHaveBeenCalledWith({ from: "2026-07-01", to: "2026-09-30" });
    expect(screen.queryByRole("list", { name: "Periods" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Period:/ })).toHaveTextContent("Last quarter");
  });

  it("applies a custom range only once both days are picked", async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: "2026-11-01", to: "2026-11-30" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Period:/ }));
    // Two calendars side by side, opening on the range's month.
    expect(screen.getAllByRole("grid")).toHaveLength(2);
    const apply = screen.getByRole("button", { name: "Apply" });
    // The open range is the current pick; click a new start then end.
    await userEvent.click(screen.getAllByRole("button", { name: /November 3rd, 2026/ })[0]);
    await userEvent.click(screen.getAllByRole("button", { name: /November 12th, 2026/ })[0]);
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    expect(onChange).toHaveBeenCalledTimes(1);
    const picked = onChange.mock.calls[0][0] as IsoRange;
    expect(picked.to).toBe("2026-11-12");
  });

  it("Cancel keeps the range", async () => {
    const onChange = vi.fn();
    render(<Harness initial={{ from: "2026-11-01", to: "2026-11-30" }} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: /^Period:/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });

  it("reads in Spanish", async () => {
    setLanguage("es");
    render(<Harness initial={{ from: "2026-11-01", to: "2026-11-30" }} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Period:/ })).toHaveTextContent("Este mes");
    await userEvent.click(screen.getByRole("button", { name: /^Period:/ }));
    expect(screen.getByRole("button", { name: "Trimestre pasado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aplicar" })).toBeInTheDocument();
    expect(screen.getByText("Rango personalizado")).toBeInTheDocument();
  });
});

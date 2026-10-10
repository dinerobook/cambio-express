import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DailyBookTile, OpenStatusPill } from "./DailyBookTile";
import styles from "./EditDailyBook.module.css";

function renderTile() {
  const onOpen = vi.fn();
  render(
    <DailyBookTile
      title="Check Deposits"
      total={101259.24}
      parts={[{ label: "Deposited", amount: 51281.24 }]}
      status={<OpenStatusPill open={1} overdue={0} openLabel="on hold" />}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

describe("DailyBookTile", () => {
  it("shows the name, status pill, total and breakdown, and opens on click", () => {
    const onOpen = renderTile();
    expect(screen.getByText("Check Deposits")).toBeInTheDocument();
    expect(screen.getByText("1 on hold")).toBeInTheDocument();
    expect(screen.getByText("$101,259.24")).toBeInTheDocument();
    expect(screen.getByText("Deposited")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // The owner saw "$101,259.24" spill past the right edge of the Check
  // Deposits box at one window width. The header must keep the total
  // in its own column and let the name side shrink and wrap.
  it("keeps the total inside the tile at any width", () => {
    renderTile();
    const total = screen.getByText("$101,259.24");
    expect(total).toHaveClass(styles.widgetTotal);
    const header = total.parentElement as HTMLElement;
    expect(header).toHaveClass(styles.widgetCardTop);
    const label = screen.getByText("Check Deposits");
    expect(label).toHaveClass(styles.widgetLabel);

    const head = getComputedStyle(header);
    expect(head.display).toBe("grid");
    expect(head.gridTemplateColumns).toBe("minmax(0, 1fr) auto");

    const name = getComputedStyle(label);
    expect(name.minWidth).toBe("0px");
    expect(name.flexWrap).toBe("wrap");

    expect(getComputedStyle(total).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(screen.getByRole("button")).minWidth).toBe("0px");
  });
});

describe("Daily book column header", () => {
  // Same rule for the In / Out header: the big total wraps under the
  // label instead of leaving the header on a narrow column.
  it("lets the total wrap under the label, never past the edge", () => {
    render(
      <div className={styles.colHeaderRow} data-testid="row">
        <span>Out</span>
        <span className={styles.colHeaderValue}>$101,259.24</span>
      </div>,
    );
    expect(getComputedStyle(screen.getByTestId("row")).flexWrap).toBe("wrap");
    expect(getComputedStyle(screen.getByText("$101,259.24")).whiteSpace).toBe("nowrap");
  });
});

describe("OpenStatusPill", () => {
  it("prefers overdue, then open, then nothing", () => {
    const { rerender, container } = render(
      <OpenStatusPill open={2} overdue={1} />,
    );
    expect(screen.getByText("1 overdue")).toBeInTheDocument();
    rerender(<OpenStatusPill open={2} overdue={0} openLabel="on hold" />);
    expect(screen.getByText("2 on hold")).toBeInTheDocument();
    rerender(<OpenStatusPill open={0} overdue={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { KpiCard, KpiGrid } from "./KpiCard";

describe("<KpiCard>", () => {
  it("renders label, value and sub", () => {
    render(<KpiCard label="Approved hours" value="12.50" sub="this week" />);
    expect(screen.getByText("Approved hours")).toBeInTheDocument();
    expect(screen.getByText("12.50")).toHaveClass("ds-kpi-value");
    expect(screen.getByText("this week")).toBeInTheDocument();
  });

  it("leaves the value in the body colour unless colorValue is set", () => {
    render(<KpiCard label="Net" value="$5.00" tone="negative" />);
    expect(screen.getByText("$5.00").style.color).toBe("");
  });

  it("paints the value in the tone colour with colorValue", () => {
    render(
      <>
        <KpiCard label="Net" value="-$5.00" tone="negative" colorValue />
        <KpiCard label="Pending" value="3.00" tone="warning" colorValue />
        <KpiCard label="Total" value="9.00" tone="primary" colorValue />
        <KpiCard label="Income" value="$9.00" tone="positive" colorValue />
        <KpiCard label="Plain" value="$1.00" tone="neutral" colorValue />
      </>,
    );
    expect(screen.getByText("-$5.00").style.color).toContain("--db-negative");
    expect(screen.getByText("3.00").style.color).toContain("--db-warning");
    expect(screen.getByText("9.00").style.color).toContain("--db-info");
    expect(screen.getByText("$9.00").style.color).toContain("--db-accent");
    // A neutral tile keeps the text colour — never a muted grey figure.
    expect(screen.getByText("$1.00").style.color).toContain("--db-text");
  });

  it("marks the root so print sheets can reset it", () => {
    render(<KpiCard label="Gross pay" value="$100.00" />);
    expect(
      screen.getByText("Gross pay").closest(".ds-kpi-card"),
    ).not.toBeNull();
  });
});

describe("<KpiGrid>", () => {
  it("lays tiles out with the given minimum width", () => {
    const { container } = render(
      <KpiGrid minWidth="9rem">
        <KpiCard label="A" value="1" />
        <KpiCard label="B" value="2" />
      </KpiGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toContain("9rem");
    expect(grid.querySelectorAll(".ds-kpi-card")).toHaveLength(2);
  });
});

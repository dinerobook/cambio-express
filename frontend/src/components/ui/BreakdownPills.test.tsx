import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { BreakdownPills } from "./BreakdownPills";

// The stacked parts of a figure on a daily book box: one small pill
// per part, coloured by position, money in the standard format. A
// zero part fades but stays; an open (not-in-the-total) part is
// outlined.

describe("<BreakdownPills>", () => {
  it("renders each part in order with its amount", () => {
    render(<BreakdownPills parts={[
      { label: "Cash", amount: 600 },
      { label: "Check", amount: 1234.5 },
    ]} />);
    expect(screen.getByText("Cash")).toHaveTextContent("Cash$600.00");
    expect(screen.getByText("Check")).toHaveTextContent("$1,234.50");
    expect(screen.getByText("Cash").compareDocumentPosition(screen.getByText("Check")))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("colours by position and wraps after five", () => {
    const parts = ["A", "B", "C", "D", "E", "F"].map((label) => ({ label, amount: 1 }));
    render(<BreakdownPills parts={parts} />);
    expect(screen.getByText("A")).toHaveAttribute("data-series", "1");
    expect(screen.getByText("E")).toHaveAttribute("data-series", "5");
    expect(screen.getByText("F")).toHaveAttribute("data-series", "1");
  });

  it("fades a zero part instead of hiding it", () => {
    render(<BreakdownPills parts={[
      { label: "Cash", amount: 0 }, { label: "Check", amount: 5 },
    ]} />);
    expect(screen.getByText("Cash")).toHaveAttribute("data-zero");
    expect(screen.getByText("Check")).not.toHaveAttribute("data-zero");
  });

  it("outlines a part that is still open", () => {
    render(<BreakdownPills parts={[
      { label: "Received today", amount: 0 },
      { label: "Owed to us", amount: 2000, open: true },
    ]} />);
    expect(screen.getByText("Owed to us")).toHaveAttribute("data-open");
    expect(screen.getByText("Received today")).not.toHaveAttribute("data-open");
  });

  it("renders nothing without parts", () => {
    const { container } = render(<BreakdownPills parts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

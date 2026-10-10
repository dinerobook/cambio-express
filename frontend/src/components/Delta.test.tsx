import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Delta } from "./Delta";

describe("<Delta>", () => {
  it("renders the formatted change plus the suffix", () => {
    const { container } = render(<Delta value={-250} money suffix=" vs prior" />);
    expect(container.textContent).toBe("▼ $250 vs prior");
  });

  it("renders nothing without a number", () => {
    const { container } = render(<Delta value={undefined} />);
    expect(container.textContent).toBe("");
  });
});

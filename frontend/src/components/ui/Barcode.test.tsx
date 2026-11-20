import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { code128Widths } from "../../lib/code128";
import { Barcode } from "./Barcode";

describe("Code 128", () => {
  it("encodes start B, the text, the check symbol and stop", () => {
    // "A" is value 33; check = (104 + 33 × 1) mod 103 = 34.
    const widths = code128Widths("A");
    expect(widths.slice(0, 6).join("")).toBe("211214"); // start B
    expect(widths.slice(6, 12).join("")).toBe("111323"); // "A"
    expect(widths.slice(12, 18).join("")).toBe("131123"); // check 34
    expect(widths.slice(18).join("")).toBe("2331112"); // stop
  });

  it("gives every symbol eleven modules and the stop thirteen", () => {
    const widths = code128Widths("K7M4Q2XP9HD3");
    const symbols = (widths.length - 7) / 6;
    expect(symbols).toBe(1 + 12 + 1);
    for (let i = 0; i < symbols; i++) {
      const w = widths.slice(i * 6, i * 6 + 6);
      expect(w.reduce((a, b) => a + b, 0)).toBe(11);
      // Bars (1st, 3rd, 5th) always add up to an even number of modules.
      expect((w[0] + w[2] + w[4]) % 2).toBe(0);
    }
    expect(widths.slice(-7).reduce((a, b) => a + b, 0)).toBe(13);
  });

  it("refuses characters set B cannot hold", () => {
    expect(() => code128Widths("é")).toThrow();
  });

  it("draws one bar per bar width, labelled for screen readers", () => {
    render(<Barcode value="A" label="Barcode for A" />);
    const svg = screen.getByRole("img", { name: "Barcode for A" });
    // Start, "A", check: three bars each; stop: four.
    expect(svg.querySelectorAll("rect")).toHaveLength(13);
  });
});

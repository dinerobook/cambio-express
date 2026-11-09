import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { setLanguage } from "./index";
import { NAV_WORDS_ES, navWord } from "./navWords";
import { CHECK_NAV, NAV, SUPPORT_LINK } from "../components/navConfig";
import { SlimSidebar } from "../components/SlimSidebar";

// The sidebar's words (UI-STANDARDS §10): NAV stays English and the
// sidebar shows each title and label through navWord().

function navWords(): string[] {
  // "Check cashing" names the check cashing app (the top-bar switch,
  // its trail and its home page title).
  const words = new Set<string>([SUPPORT_LINK.label, "Check cashing"]);
  for (const g of [...NAV, ...CHECK_NAV]) {
    words.add(g.title);
    for (const i of g.items) words.add(i.label);
  }
  return [...words];
}

describe("sidebar words", () => {
  it("has Spanish for every NAV title and label", () => {
    expect(navWords().filter((w) => !NAV_WORDS_ES[w])).toEqual([]);
  });

  it("has no Spanish left over for a label NAV no longer has", () => {
    const live = new Set(navWords());
    expect(Object.keys(NAV_WORDS_ES).filter((w) => !live.has(w))).toEqual([]);
  });

  it("leaves English untouched", () => {
    for (const w of navWords()) expect(navWord(w)).toBe(w);
  });

  it("shows Spanish in the sidebar while hub links keep English slugs", () => {
    const daily = NAV.find((g) => g.title === "Daily")!;
    const items = daily.items.filter((i) => i.label === "MSB daily book");
    setLanguage("es");
    render(
      <MemoryRouter>
        <SlimSidebar
          groups={[{ ...daily, items }]}
          drawerOpen
          supportLink={SUPPORT_LINK}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole("complementary", { name: "Navegación principal" });
    expect(within(nav).getAllByText("Diario").length).toBeGreaterThan(0);
    expect(within(nav).getByText("Libro diario MSB")).toBeInTheDocument();
    expect(within(nav).getAllByText("Soporte").length).toBeGreaterThan(0);
    // The drawer's group title links to the English-slug hub URL.
    const hubLink = within(nav).getAllByText("Diario")
      .map((el) => el.closest("a")).find(Boolean);
    expect(hubLink).toHaveAttribute("href", "/hub/daily");
  });
});

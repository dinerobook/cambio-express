import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyTheme,
  getCurrentTheme,
  reconcileTheme,
  THEME_CHROME_COLOR,
} from "./theme";

function themeColorMeta(): HTMLMetaElement {
  return document.querySelector('meta[name="theme-color"]') as HTMLMetaElement;
}

describe("theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.setAttribute("data-theme", "dark");
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = THEME_CHROME_COLOR.dark;
    document.head.appendChild(meta);
  });

  afterEach(() => {
    themeColorMeta()?.remove();
  });

  it("defaults to dark when the attribute is missing or unknown", () => {
    document.documentElement.removeAttribute("data-theme");
    expect(getCurrentTheme()).toBe("dark");
    document.documentElement.setAttribute("data-theme", "sepia");
    expect(getCurrentTheme()).toBe("dark");
  });

  it("applyTheme flips the page, the device cache and the browser bar", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem("dinerobook.theme")).toBe("light");
    expect(themeColorMeta().content).toBe(THEME_CHROME_COLOR.light);

    applyTheme("dark");
    expect(getCurrentTheme()).toBe("dark");
    expect(themeColorMeta().content).toBe(THEME_CHROME_COLOR.dark);
  });

  it("applyTheme still works on a page without a theme-color tag", () => {
    themeColorMeta().remove();
    applyTheme("light");
    expect(getCurrentTheme()).toBe("light");
  });

  it("reconcileTheme lets the server preference win, and ignores no preference", () => {
    reconcileTheme(undefined);
    expect(getCurrentTheme()).toBe("dark");
    reconcileTheme("light");
    expect(getCurrentTheme()).toBe("light");
    expect(themeColorMeta().content).toBe(THEME_CHROME_COLOR.light);
  });
});

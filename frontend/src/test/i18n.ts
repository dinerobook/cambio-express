// Test helper for screens covered by the translator (UI-STANDARDS
// §10): render the screen in Spanish, then check that none of the
// English words for its area are still showing.
//
//   setLanguage("es");
//   render(<Login />);
//   expect(englishLeftovers(document.body, ["login."])).toEqual([]);

import { en, type MessageKey } from "../i18n/en";
import { es } from "../i18n/es";

/** English values (of keys under `prefixes`) still visible inside
 *  `root` — its text, or a label / placeholder / title attribute. */
export function englishLeftovers(root: HTMLElement, prefixes: string[]): string[] {
  const attrs = [...root.querySelectorAll("*")].flatMap((el) =>
    ["aria-label", "placeholder", "title"]
      .map((a) => el.getAttribute(a) ?? ""),
  );
  const visible = [root.textContent ?? "", ...attrs].join("\n");
  return (Object.keys(en) as MessageKey[])
    .filter((k) => prefixes.some((p) => k.startsWith(p)))
    // Skip words the Spanish keeps on purpose ("Idioma (Language)").
    .filter((k) => !es[k].includes(en[k]))
    // A template's fixed part: "Store #{id}" → "Store #".
    .map((k) => en[k].split(/\{\w+\}/)[0].trim())
    .filter((text) => text.length >= 4 && wholeWord(text).test(visible));
}

/** "Cancel" must not match inside "Cancelar". */
function wholeWord(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "u");
}

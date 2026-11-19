import type { ReactNode } from "react";

import { fontSize, space, tokens } from "./tokens";

/** Section header — h2 in the display font. Used standalone or
 *  inside ``<Section>``. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    // `ds-section-title` spaces a title that opens a <Card> from
    // what follows it (ui.css). Cards have no gap of their own, so a
    // bare title sat on the first row of labels.
    <h2
      className="ds-section-title"
      style={{
        fontFamily: tokens.fontDisplay,
        fontSize: fontSize.lg,
        fontWeight: 600,
        // margin lives in the class (ui.css) so the in-card spacing
        // rule can add to it; an inline margin would beat it.
      }}
    >
      {children}
    </h2>
  );
}


/** Wrapper for a labelled section: optional title + right-aligned
 *  actions slot + a body. Children stack with ``space.md`` gap. */
export function Section({
  title, actions, children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    // `ds-section`: two Sections in one Card ("Basic info", then
    // "Contact") get a divider and room between them (ui.css) —
    // they used to touch, the second title on the last field.
    <section
      className="ds-section"
      style={{ display: "flex", flexDirection: "column", gap: space.md }}
    >
      {(title || actions) && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.lg,
            flexWrap: "wrap",
          }}
        >
          {title ? <SectionTitle>{title}</SectionTitle> : <span />}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

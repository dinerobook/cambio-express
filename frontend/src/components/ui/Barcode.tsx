import { code128Widths } from "../../lib/code128";
import styles from "./Barcode.module.css";

// Blank modules on each side: scanners need a quiet zone of ten.
const QUIET = 10;

/** A Code 128 barcode a handheld scanner reads back as typed text —
 * for codes someone scans into another program, like DineroBook
 * Manager's connect code. Always dark bars on white (``--db-paper``)
 * whatever the theme: scanners do not read light-on-dark. */
export function Barcode({ value, label }: { value: string; label: string }) {
  const widths = code128Widths(value);
  const modules = widths.reduce((a, b) => a + b, 0) + QUIET * 2;
  const bars: { x: number; w: number }[] = [];
  let x = QUIET;
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return (
    <svg
      className={styles.barcode}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} 60`}
      width={modules * 2}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
    >
      {bars.map((b) => (
        <rect key={b.x} x={b.x} y={0} width={b.w} height={60} />
      ))}
    </svg>
  );
}

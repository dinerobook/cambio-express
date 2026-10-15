import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { BRAND_NAME } from "../lib/brand";
import { PRODUCT_FEATURES } from "../lib/productFeatures";
import styles from "./LoginShowcase.module.css";

/** How long each feature stays up before the panel moves on. */
export const SHOWCASE_INTERVAL_MS = 6000;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The features half of the sign-in page. Most people who open the
 *  site are signing in, so the form gets the other half and this
 *  panel tells a first-time visitor what the product does: one
 *  module at a time from PRODUCT_FEATURES (the same list the full
 *  /features page renders), with a dot per module to jump to it.
 *
 *  It advances on its own every SHOWCASE_INTERVAL_MS, pauses while
 *  the pointer or keyboard focus is inside it, and never advances
 *  for someone who asked for reduced motion. */
export function LoginShowcase() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [autoplay] = useState(() => !prefersReducedMotion());
  const feature = PRODUCT_FEATURES[index];

  useEffect(() => {
    if (!autoplay || paused) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % PRODUCT_FEATURES.length);
    }, SHOWCASE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [autoplay, paused]);

  return (
    <section
      className={styles.panel}
      aria-label={`What ${BRAND_NAME} does`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className={styles.eyebrow}>
        <span className={styles.eyebrowDot} aria-hidden="true" />
        C-STORES · GAS STATIONS · MONEY SERVICES
      </div>
      <h1 className={styles.title}>
        Your register already knows what sold today.{" "}
        <span className={styles.accent}>Now your books do too.</span>
      </h1>

      {/* key= remounts the card on every swap so its enter
          animation plays again. */}
      <div
        key={feature.eye}
        className={styles.card}
        aria-live={autoplay && !paused ? "off" : "polite"}
      >
        <div className={styles.cardEye}>{feature.eye}</div>
        <div className={styles.cardTitle}>{feature.title}</div>
        <ul className={styles.cardList}>
          {feature.points.map((p) => <li key={p}>{p}</li>)}
        </ul>
      </div>

      <div className={styles.dots}>
        {PRODUCT_FEATURES.map((f, i) => (
          <button
            key={f.eye}
            type="button"
            className={styles.dot}
            aria-label={`Show ${f.eye.toLowerCase()}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>

      <div className={styles.links}>
        <Link to="/features" className={styles.link}>
          See everything {BRAND_NAME} does →
        </Link>
        <Link to="/signup" className={styles.link}>
          Start a 7-day free trial →
        </Link>
      </div>
    </section>
  );
}

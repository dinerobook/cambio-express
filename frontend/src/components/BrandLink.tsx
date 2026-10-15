import { Link } from "react-router-dom";

import { BRAND_NAME } from "../lib/brand";
import styles from "./BrandLink.module.css";

/** Brand mark + name, linking to the site root. The top bar of every
 *  public page (AuthChrome, the /features page) and the /features
 *  footer render this one component. */
export function BrandLink() {
  return (
    <Link to="/" className={styles.brand}>
      <img className={styles.mark} src="/static/brand-mark.svg" alt="" />
      <span className={styles.name}>{BRAND_NAME}</span>
    </Link>
  );
}

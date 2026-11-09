import type { ReactNode } from "react";

import { AppLink, Card } from "./ui";
import styles from "./NavTileGrid.module.css";

export interface NavTile {
  to: string;
  icon: ReactNode;
  /** Already in the person's language. */
  label: string;
  desc?: string;
}

/** The "pick where to go" grid of linked tiles: a nav section's hub
 *  and the check cashing home. A tile whose page the person cannot
 *  open disappears with its link (AppLink, UI-STANDARDS §8). */
export function NavTileGrid({ tiles }: { tiles: NavTile[] }) {
  return (
    <div className={styles.grid}>
      {tiles.map((tile) => (
        <AppLink key={tile.to} to={tile.to} className={styles.tileLink}>
          <Card interactive>
            <div className={styles.tile}>
              <span className={styles.iconWrap} aria-hidden="true">
                {tile.icon}
              </span>
              <span className={styles.tileBody}>
                <span className={styles.tileTitle}>{tile.label}</span>
                {tile.desc && <span className={styles.tileDesc}>{tile.desc}</span>}
              </span>
            </div>
          </Card>
        </AppLink>
      ))}
    </div>
  );
}

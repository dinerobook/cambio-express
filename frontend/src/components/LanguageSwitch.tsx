import { LANGUAGES, LANGUAGE_NAMES, setLanguage, useLanguage, useT } from "../i18n";
import styles from "./LanguageSwitch.module.css";

/** "EN | ES" on every signed-out page (AuthChrome's nav). Before
 *  sign-in nobody is known yet, so the choice is remembered on this
 *  device only; after sign-in the person's profile language wins
 *  (Settings → Profile). Each button carries its language's own
 *  name, so someone who can't read the current language still
 *  finds theirs. */
export function LanguageSwitch() {
  const current = useLanguage();
  const t = useT();
  return (
    <div className={styles.switch} role="group" aria-label={t("common.language")}>
      {LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          lang={lang}
          className={styles.option}
          aria-pressed={current === lang}
          aria-label={LANGUAGE_NAMES[lang]}
          title={LANGUAGE_NAMES[lang]}
          onClick={() => setLanguage(lang)}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

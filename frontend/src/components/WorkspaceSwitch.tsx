import { useNavigate } from "react-router-dom";

import { CHECK_HOME, type Workspace } from "./navConfig";
import { useT } from "../i18n";

/** "Back office | Check cashing" — moves the whole app between the
 *  two views (navConfig "Workspaces", UI-STANDARDS §8). Rendered only
 *  for someone who has both. In the top bar on a desktop and at the
 *  top of the drawer on a phone (`placement`), where the top bar has
 *  no room for it. */
export function WorkspaceSwitch({
  current, placement,
}: {
  current: Workspace;
  placement: "topbar" | "drawer";
}) {
  const t = useT();
  const navigate = useNavigate();
  const options: { value: Workspace; label: string; to: string }[] = [
    { value: "backoffice", label: t("shell.workspaceBackOffice"), to: "/dashboard" },
    { value: "checks", label: t("shell.workspaceChecks"), to: CHECK_HOME },
  ];
  return (
    <div
      role="group"
      aria-label={t("shell.workspaceSwitch")}
      className={`app-workspace-switch is-${placement}`}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={current === o.value}
          className={current === o.value ? "is-active" : undefined}
          onClick={() => { if (current !== o.value) navigate(o.to); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

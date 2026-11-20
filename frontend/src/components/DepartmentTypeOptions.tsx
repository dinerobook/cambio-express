import { TYPE_GROUPS, TYPE_LABEL, type TypeGroupKey } from "../lib/departmentTypes";
import { t, useT } from "../i18n";

/** The `<option>`s of a department type picker, grouped the way
 *  Modisoft groups them. With `group`, only that group's types (the
 *  Modisoft import narrows a Lottery or Services row this way). */
export function DepartmentTypeOptions({ group }: { group?: TypeGroupKey }) {
  useT(); // re-render on a language switch
  const groups = group ? TYPE_GROUPS.filter((g) => g.key === group) : TYPE_GROUPS;
  return (
    <>
      {groups.map((g) => (
        <optgroup key={g.key} label={t(g.label)}>
          {g.types.map((ty) => (
            <option key={ty} value={ty}>{t(TYPE_LABEL[ty])}</option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

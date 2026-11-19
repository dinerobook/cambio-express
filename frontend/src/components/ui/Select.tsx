import { fieldAria, useFieldControl } from "./fieldContext";
import { inputStyle } from "./tokens";

/** Token-styled ``<select>`` with the same focus glow as ``<Input>``,
 *  and the same `<Field>` wiring (fieldContext.ts). */
export function Select({
  className, style, children, ...rest
}: React.ComponentProps<"select">) {
  const field = useFieldControl();
  return (
    <select
      {...rest}
      {...fieldAria(field, rest)}
      className={["ds-input", "ds-select", className].filter(Boolean).join(" ")}
      style={{ ...inputStyle, ...style }}
    >
      {children}
    </select>
  );
}

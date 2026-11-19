import { fieldAria, useFieldControl } from "./fieldContext";
import { inputStyle } from "./tokens";

/** Token-styled text/number/date input with the ds-input focus
 *  glow class applied. Forwards every standard input prop. Inside a
 *  `<Field>` it is described by the field's hint / error and marked
 *  invalid / required from it (fieldContext.ts). */
export function Input({
  className, style, ...rest
}: React.InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldControl();
  return (
    <input
      {...rest}
      {...fieldAria(field, rest)}
      className={["ds-input", className].filter(Boolean).join(" ")}
      style={{ ...inputStyle, ...style }}
    />
  );
}

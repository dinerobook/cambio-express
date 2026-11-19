import { fieldAria, useFieldControl } from "./fieldContext";
import { inputStyle, tokens } from "./tokens";

/** Token-styled ``<textarea>``, wired to its `<Field>` like ``<Input>``. */
export function Textarea({
  className, style, ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldControl();
  return (
    <textarea
      {...rest}
      {...fieldAria(field, rest)}
      className={["ds-input", className].filter(Boolean).join(" ")}
      style={{
        ...inputStyle,
        fontFamily: tokens.fontBody,
        minHeight: "5rem",
        resize: "vertical",
        ...style,
      }}
    />
  );
}

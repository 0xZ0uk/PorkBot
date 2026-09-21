import type { ComponentPropsWithRef, ReactNode } from "react";

export type FieldProps = {
  /** The visible label; the control is associated in `label` or `htmlFor`. */
  readonly label: string;
  /** The control's id when it is not nested in the label. */
  readonly htmlFor?: string | undefined;
  /** A short rule below the control, such as a length limit. */
  readonly hint?: string | undefined;
  /** The validation message; it carries `role="alert"`. */
  readonly error?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
};

/**
 * A labelled control. The label wraps the control, so association works with
 * or without an explicit id; hint and error are rendered below it and the
 * error announces itself.
 */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  return (
    <label className={["pb-field", className].filter(Boolean).join(" ")} htmlFor={htmlFor}>
      <span className="pb-field__label">{label}</span>
      {children}
      {hint === undefined ? null : <span className="pb-field__hint">{hint}</span>}
      {error === undefined ? null : (
        <span className="pb-field__error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

export type InputProps = Omit<ComponentPropsWithRef<"input">, "className"> & {
  /** Marks the control invalid for assistive technology and the stylesheet. */
  readonly invalid?: boolean;
  readonly className?: string;
};

export function Input({ invalid = false, className, ...rest }: InputProps) {
  return (
    <input
      className={["pb-input", className].filter(Boolean).join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

export type TextareaProps = Omit<ComponentPropsWithRef<"textarea">, "className"> & {
  readonly invalid?: boolean;
  readonly className?: string;
};

export function Textarea({ invalid = false, className, ...rest }: TextareaProps) {
  return (
    <textarea
      className={["pb-textarea", className].filter(Boolean).join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

export type SelectProps = Omit<ComponentPropsWithRef<"select">, "className"> & {
  readonly invalid?: boolean;
  readonly className?: string;
};

export function Select({ invalid = false, className, ...rest }: SelectProps) {
  return (
    <select
      className={["pb-select", className].filter(Boolean).join(" ")}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

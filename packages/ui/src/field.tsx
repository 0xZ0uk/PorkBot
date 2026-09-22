import type { ComponentPropsWithRef, ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./lib/utils.ts";

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

const controlVariants = cva(
  "w-full rounded-lg border border-border bg-background px-2 py-2 font-sans text-body text-foreground disabled:cursor-not-allowed disabled:opacity-60 focus-visible:border-primary",
  {
    variants: {
      invalid: {
        true: "border-destructive",
        false: "",
      },
    },
    defaultVariants: { invalid: false },
  },
);

/**
 * A labelled control. The label wraps the control, so association works with
 * or without an explicit id; hint and error are rendered below it and the
 * error announces itself.
 */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  return (
    <label className={cn("flex flex-col gap-1", className)} htmlFor={htmlFor}>
      <span className="text-meta text-muted-foreground">{label}</span>
      {children}
      {hint === undefined ? null : <span className="text-meta text-muted-foreground">{hint}</span>}
      {error === undefined ? null : (
        <span className="text-meta text-destructive" role="alert">
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
      className={cn(controlVariants({ invalid }), className)}
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
      className={cn(controlVariants({ invalid }), "resize-y", className)}
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
      className={cn(controlVariants({ invalid }), className)}
      aria-invalid={invalid ? true : undefined}
      {...rest}
    />
  );
}

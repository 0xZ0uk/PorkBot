import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";

export type CardVariant = "flat" | "raised" | "interactive";

type CardOwnProps = {
  readonly variant?: CardVariant;
  readonly className?: string;
  readonly children: ReactNode;
};

/**
 * The card is a surface, so the element it draws is the caller's: a form on
 * sign-in, a list item in a roster, a div anywhere else.
 */
export type CardProps = CardOwnProps &
  (
    | ({ readonly as?: "div" } & Omit<ComponentPropsWithoutRef<"div">, "className" | "children">)
    | ({ readonly as: "form" } & Omit<ComponentPropsWithoutRef<"form">, "className" | "children">)
    | ({ readonly as: "section" } & Omit<
        ComponentPropsWithoutRef<"section">,
        "className" | "children"
      >)
    | ({ readonly as: "article" } & Omit<
        ComponentPropsWithoutRef<"article">,
        "className" | "children"
      >)
    | ({ readonly as: "li" } & Omit<ComponentPropsWithoutRef<"li">, "className" | "children">)
  );

export function Card({ variant = "flat", className, children, ...rest }: CardProps) {
  const { as: tag, ...elementProps } = rest as { as?: string } & Record<string, unknown>;
  const Element = (tag ?? "div") as ElementType;
  const classes = ["pb-card", variant !== "flat" && `pb-card--${variant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <Element className={classes} {...elementProps}>
      {children}
    </Element>
  );
}

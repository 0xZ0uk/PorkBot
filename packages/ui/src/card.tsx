import type { ComponentPropsWithoutRef, ElementType, ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./lib/utils.ts";

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

const cardVariants = cva(
  "flex flex-col gap-3 rounded-xl border border-border bg-card p-4 [&>h1]:m-0 [&>h1]:text-title [&>h2]:m-0 [&>h2]:text-title [&>h3]:m-0 [&>h3]:text-title",
  {
    variants: {
      variant: {
        flat: "",
        raised: "shadow-raised",
        interactive: "cursor-pointer shadow-raised transition-colors hover:bg-accent",
      },
    },
    defaultVariants: { variant: "flat" },
  },
);

export function Card({ variant = "flat", className, children, ...rest }: CardProps) {
  const { as: tag, ...elementProps } = rest as { as?: string } & Record<string, unknown>;
  const Element = (tag ?? "div") as ElementType;

  return (
    <Element className={cn(cardVariants({ variant }), className)} data-card {...elementProps}>
      {children}
    </Element>
  );
}

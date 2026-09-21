import { cloneElement, isValidElement, useId, useState } from "react";
import type { ReactElement, ReactNode } from "react";

export type TooltipProps = {
  readonly content: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
};

/**
 * A tooltip on hover and focus (design record, Component register). Escape
 * hides it without moving focus; the trigger keeps its own semantics and gains
 * an `aria-describedby` while the bubble is open.
 */
export function Tooltip({ content, children, className }: TooltipProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const id = useId();
  const open = hovered || focused;

  function close(): void {
    setHovered(false);
    setFocused(false);
  }

  const child = isValidElement(children)
    ? (children as ReactElement<{ "aria-describedby"?: string }>)
    : null;
  const describedBy = open
    ? [child?.props["aria-describedby"], id].filter(Boolean).join(" ")
    : child?.props["aria-describedby"];

  const trigger =
    child === null || describedBy === undefined
      ? children
      : cloneElement(child, { "aria-describedby": describedBy });

  return (
    <span
      className={["pb-tooltip", className].filter(Boolean).join(" ")}
      onMouseEnter={() => {
        setHovered(true);
      }}
      onMouseLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          close();
        }
      }}
    >
      {trigger}
      {open ? (
        <span className="pb-tooltip__bubble" role="tooltip" id={id}>
          {content}
        </span>
      ) : null}
    </span>
  );
}

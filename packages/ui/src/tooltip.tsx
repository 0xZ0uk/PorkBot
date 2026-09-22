import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
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
export function Tooltip({ content, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = isValidElement(children) ? (
    (children as ReactElement<{ "aria-describedby"?: string | undefined }>)
  ) : (
    <span className="inline-flex">{children}</span>
  );
  const describedBy = open
    ? [trigger.props["aria-describedby"], id].filter(Boolean).join(" ")
    : trigger.props["aria-describedby"];
  const triggerElement = cloneElement(trigger, {
    "aria-describedby": describedBy,
  });
  return (
    <BaseTooltip.Root open={open} onOpenChange={setOpen}>
      <BaseTooltip.Trigger delay={0} render={triggerElement} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={4}>
          <BaseTooltip.Popup
            role="tooltip"
            id={id}
            className="z-50 max-w-64 rounded-lg border border-border bg-accent px-2 py-1 text-meta text-foreground shadow-overlay"
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

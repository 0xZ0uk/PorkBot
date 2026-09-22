import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Button } from "./button.tsx";
import type { ButtonVariant } from "./button.tsx";
import { Icon } from "./icon.tsx";
import { cn } from "./lib/utils.ts";

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  /** Draws the item in the destructive colour; the caller owns the consequence. */
  readonly destructive?: boolean;
  readonly disabled?: boolean;
};

export type MenuProps = {
  /** The trigger's visible label. */
  readonly label: string;
  /**
   * The trigger's accessible name when the visible label needs the item's
   * context — a roster of menus all labelled "Actions" is one name. It must
   * contain the visible label so speech input still reaches the control.
   */
  readonly ariaLabel?: string | undefined;
  readonly items: readonly MenuItem[];
  readonly variant?: ButtonVariant;
  readonly align?: "start" | "end";
  readonly className?: string;
};

/**
 * A menu on the button + popup pattern: Enter, Space and ArrowDown open it,
 * the arrows and Home/End move, Escape and Tab close it and return focus to
 * the trigger, and a pointer press outside closes it. Items are buttons, so
 * activation is the platform's.
 */
export function Menu({
  label,
  ariaLabel,
  items,
  variant = "neutral",
  align = "start",
  className,
}: MenuProps) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger
        render={
          <Button variant={variant} aria-label={ariaLabel} className={className}>
            {label}
            <Icon name="chevron-down" aria-hidden="true" />
          </Button>
        }
      />
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={4} align={align === "end" ? "end" : "start"}>
          <BaseMenu.Popup
            className={cn(
              "z-30 flex min-w-48 flex-col gap-0.5 rounded-xl border border-border bg-card p-1 shadow-overlay",
            )}
          >
            {items.map((item) => (
              <BaseMenu.Item
                key={item.id}
                disabled={item.disabled === true}
                data-destructive={item.destructive === true ? "true" : undefined}
                onClick={() => {
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-1 text-left text-body text-foreground",
                  item.destructive === true ? "text-destructive" : "",
                  "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {item.label}
              </BaseMenu.Item>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

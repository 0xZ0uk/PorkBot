import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cn } from "./lib/utils.ts";

export type TabItem = {
  readonly id: string;
  readonly label: string;
  readonly panel: ReactNode;
};

export type TabsProps = {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onSelect: (id: string) => void;
  /** The tab list's accessible name. */
  readonly label: string;
  readonly className?: string;
};

/**
 * Tabs with the ARIA pattern's keyboard behaviour: arrows move focus and
 * selection, Home and End jump to the ends, and the inactive panels stay in
 * the document so switching back costs nothing.
 */
export function Tabs({ items, active, onSelect, label, className }: TabsProps) {
  return (
    <BaseTabs.Root
      value={active}
      onValueChange={(value) => {
        onSelect(String(value));
      }}
      className={cn("flex flex-col gap-3", className)}
    >
      <BaseTabs.List
        activateOnFocus
        aria-label={label}
        className="flex gap-1 border-b border-border"
      >
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.id}
            value={item.id}
            className="cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-2 py-1 text-body text-muted-foreground hover:bg-accent hover:text-foreground aria-selected:border-primary aria-selected:text-foreground"
          >
            {item.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {items.map((item) => (
        <BaseTabs.Panel key={item.id} value={item.id} keepMounted className="min-h-0">
          {item.panel}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}

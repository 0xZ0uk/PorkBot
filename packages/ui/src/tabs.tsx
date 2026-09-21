import { useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

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
 * the document with `hidden` set so switching back costs nothing.
 */
export function Tabs({ items, active, onSelect, label, className }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  function move(offset: number, absolute?: number): void {
    const index = items.findIndex((item) => item.id === active);

    if (index === -1) {
      return;
    }

    const next = absolute ?? (index + offset + items.length) % items.length;
    const item = items[next];

    if (item !== undefined) {
      tabRefs.current.get(item.id)?.focus();
      onSelect(item.id);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      move(0, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      move(0, items.length - 1);
    }
  }

  return (
    <div className={["pb-tabs", className].filter(Boolean).join(" ")}>
      <div className="pb-tab-list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item) => (
          <button
            key={item.id}
            ref={(node) => {
              if (node === null) {
                tabRefs.current.delete(item.id);
              } else {
                tabRefs.current.set(item.id, node);
              }
            }}
            className="pb-tab"
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.id}`}
            aria-selected={item.id === active}
            aria-controls={`${baseId}-panel-${item.id}`}
            tabIndex={item.id === active ? 0 : -1}
            onClick={() => {
              onSelect(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          className="pb-tab-panel"
          id={`${baseId}-panel-${item.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${item.id}`}
          hidden={item.id !== active}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}

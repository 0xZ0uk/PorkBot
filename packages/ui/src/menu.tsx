import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "./icon.tsx";
import type { ButtonVariant } from "./button.tsx";

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
export function Menu({ label, items, variant = "neutral", align = "start", className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openAt = useRef<"first" | "last">("first");

  useEffect(() => {
    if (!open) {
      return;
    }

    const index = openAt.current === "first" ? 0 : items.length - 1;
    itemRefs.current[index]?.focus();

    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node;

      if (
        menuRef.current?.contains(target) === true ||
        triggerRef.current?.contains(target) === true
      ) {
        return;
      }

      setOpen(false);
    }

    function onDocumentKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
    };
  }, [open, items.length]);

  function close(refocus: boolean): void {
    setOpen(false);

    if (refocus) {
      triggerRef.current?.focus();
    }
  }

  function focusItem(index: number): void {
    const clamped = (index + items.length) % items.length;
    itemRefs.current[clamped]?.focus();
  }

  function indexOfFocused(): number {
    return itemRefs.current.findIndex((node) => node === document.activeElement);
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(indexOfFocused() + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(indexOfFocused() - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <span className={["pb-menu", className].filter(Boolean).join(" ")} ref={menuRef}>
      <button
        ref={triggerRef}
        className={["pb-button", `pb-button--${variant}`].join(" ")}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          openAt.current = "first";

          if (open) {
            close(false);
          } else {
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAt.current = "first";
            setOpen(true);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openAt.current = "last";
            setOpen(true);
          }
        }}
      >
        {label}
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div
          className={["pb-menu__popup", align === "end" && "pb-menu__popup--end"]
            .filter(Boolean)
            .join(" ")}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              className={[
                "pb-menu__item",
                item.destructive === true && "pb-menu__item--destructive",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

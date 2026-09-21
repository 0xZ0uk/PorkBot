import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, ReactNode } from "react";

export type DialogProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly description?: string;
  /** The body; a sheet's content page usually goes here. */
  readonly children?: ReactNode;
  /** The actions row, right-aligned under the body. */
  readonly actions?: ReactNode;
};

type DialogVariant = "dialog" | "sheet";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * A dialog on the ARIA modal pattern: opening moves focus into the panel,
 * Tab and Shift+Tab stay inside it, Escape and a backdrop press close it, and
 * closing returns focus to the element that opened it. A sheet is the same
 * behaviour anchored to the viewport's bottom.
 *
 * The portal targets its own container, created and removed with this
 * component, rather than `document.body` directly. React attaches its event
 * listeners to a portal's container and never detaches them while the
 * container lives; a container that outlives its root leaves those listeners
 * on `document.body`, where a second React root in the same document — the
 * test harness mounts the app twice to prove a reload — can dispatch an event
 * into the stale root's fiber tree. One container per dialog keeps the
 * listeners and their lifetime together.
 */
function DialogSurface({
  variant,
  open,
  onClose,
  title,
  description,
  children,
  actions,
}: DialogProps & { readonly variant: DialogVariant }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [container] = useState(() =>
    typeof document === "undefined" ? null : document.createElement("div"),
  );

  useEffect(() => {
    if (container === null) {
      return;
    }

    document.body.append(container);

    return () => {
      container.remove();
    };
  }, [container]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocus.current = document.activeElement;
    panelRef.current?.focus();

    return () => {
      const previous = previousFocus.current;

      if (previous instanceof HTMLElement) {
        previous.focus();
      }
    };
  }, [open]);

  if (!open || container === null) {
    return null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const panel = panelRef.current;

    if (panel === null) {
      return;
    }

    const focusable = [...panel.querySelectorAll<HTMLElement>(focusableSelector)];

    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (first === undefined || last === undefined) {
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className={["pb-dialog", variant === "sheet" && "pb-sheet"].filter(Boolean).join(" ")}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="pb-dialog__panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 className="pb-dialog__title" id={titleId}>
          {title}
        </h2>
        {description === undefined ? null : (
          <p className="pb-dialog__description" id={descriptionId}>
            {description}
          </p>
        )}
        {children}
        {actions === undefined ? null : <div className="pb-dialog__actions">{actions}</div>}
      </div>
    </div>,
    container,
  );
}

export function Dialog(props: DialogProps) {
  return <DialogSurface {...props} variant="dialog" />;
}

export function Sheet(props: DialogProps) {
  return <DialogSurface {...props} variant="sheet" />;
}

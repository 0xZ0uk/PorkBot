import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";
import { cn } from "./lib/utils.ts";

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

/**
 * A dialog on the ARIA modal pattern: opening moves focus into the panel,
 * Tab and Shift+Tab stay inside it, Escape and a backdrop press close it, and
 * closing returns focus to the element that opened it. A sheet is the same
 * behaviour anchored to the viewport's bottom.
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
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          className={cn(
            "fixed inset-0 z-40 bg-foreground/45",
            variant === "sheet" ? "flex items-end" : "flex items-center justify-center p-4",
          )}
        />
        <BaseDialog.Popup
          className={cn(
            "fixed z-50 flex flex-col gap-3 overflow-auto border border-border bg-card shadow-overlay outline-none",
            variant === "dialog"
              ? "inset-x-4 top-1/2 mx-auto max-h-[calc(100vh-2rem)] w-full max-w-md -translate-y-1/2 rounded-xl p-6"
              : "inset-x-0 bottom-0 max-h-[90vh] w-full rounded-t-xl p-6",
          )}
        >
          <BaseDialog.Title className="m-0 text-title">{title}</BaseDialog.Title>
          {description === undefined ? null : (
            <BaseDialog.Description className="m-0 text-body text-muted-foreground">
              {description}
            </BaseDialog.Description>
          )}
          {children}
          {actions === undefined ? null : <div className="flex justify-end gap-2">{actions}</div>}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

export function Dialog(props: DialogProps) {
  return <DialogSurface {...props} variant="dialog" />;
}

export function Sheet(props: DialogProps) {
  return <DialogSurface {...props} variant="sheet" />;
}

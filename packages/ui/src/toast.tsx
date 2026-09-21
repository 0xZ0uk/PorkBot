import { createContext, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, IconButton } from "./button.tsx";

export type ToastTone = "neutral" | "success" | "warning" | "destructive";

export type ToastInput = {
  readonly title: string;
  readonly body?: string;
  readonly tone?: ToastTone;
  /** One follow-up action, such as opening the run that finished. */
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
  };
};

type ToastRecord = ToastInput & { readonly id: string };

export type ToastApi = {
  /** Shows a toast and returns the id `dismiss` takes. */
  readonly push: (toast: ToastInput) => string;
  readonly dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);

  if (api === null) {
    throw new Error("useToast must be used below a ToastProvider.");
  }

  return api;
}

/**
 * The toast host: it owns the queue, renders the region and hands screens a
 * `push`/`dismiss` pair. A toast announces politely, dismisses with a labelled
 * control, and carries at most one action link.
 */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  const counter = useRef(0);

  const api = useMemo<ToastApi>(
    () => ({
      push(toast) {
        counter.current += 1;
        const id = `toast-${String(counter.current)}`;
        setToasts((current) => [...current, { ...toast, id }]);
        return id;
      },
      dismiss(id) {
        setToasts((current) => current.filter((entry) => entry.id !== id));
      },
    }),
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pb-toast-region" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={["pb-toast", toast.tone !== undefined && `pb-toast--${toast.tone}`]
              .filter(Boolean)
              .join(" ")}
            role="status"
          >
            <div className="pb-toast__header">
              <span className="pb-toast__title">{toast.title}</span>
              <IconButton
                label={`Dismiss ${toast.title}`}
                icon="close"
                onClick={() => {
                  api.dismiss(toast.id);
                }}
              />
            </div>
            {toast.body === undefined ? null : <p className="pb-toast__body">{toast.body}</p>}
            {toast.action === undefined ? null : (
              <div className="pb-toast__actions">
                <Button variant="ghost" onClick={toast.action.onClick}>
                  {toast.action.label}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

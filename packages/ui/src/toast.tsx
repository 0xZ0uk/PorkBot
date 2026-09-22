import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";

export type ToastTone = "neutral" | "success" | "warning" | "destructive";

export type ToastInput = {
  readonly title: string;
  readonly body?: string;
  readonly tone?: ToastTone;
  /** One follow-up action, such as opening the run that finished. */
  readonly action?: {
    readonly label: string;
    readonly href?: string;
    readonly onClick?: () => void;
  };
};

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

type Show = (message: string, options: Parameters<typeof toast>[1]) => string | number;

const toneToShow: Record<ToastTone, Show> = {
  neutral: (message, options) => toast(message, options),
  success: (message, options) => toast.success(message, options),
  warning: (message, options) => toast.warning(message, options),
  destructive: (message, options) => toast.error(message, options),
};

/**
 * The toast host. `sonner` owns the queue, the pause-on-hover and the live
 * region; this module owns the `push`/`dismiss` pair the screens call and the
 * one-action-a-toast rule the design record asks for.
 *
 * A destination keeps its link role: when the action names an `href` it renders
 * as an `<a>` in the toast body rather than as sonner's action button, so a
 * user hears "link" and can open it in a new tab. A bare `onClick` is an
 * in-place action and takes sonner's button.
 */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const api = useMemo<ToastApi>(
    () => ({
      push: (input) => {
        const show = toneToShow[input.tone ?? "neutral"];
        const action = input.action;
        const destination = action?.href;
        const description =
          input.body === undefined && destination === undefined
            ? undefined
            : ((
                <>
                  {input.body}
                  {destination === undefined ? null : (
                    <>
                      {input.body === undefined ? "" : " "}
                      <a
                        href={destination}
                        onClick={() => {
                          action?.onClick?.();
                        }}
                      >
                        {action?.label}
                      </a>
                    </>
                  )}
                </>
              ) as ReactNode);

        const id = show(input.title, {
          description,
          ...(destination === undefined && action !== undefined
            ? {
                action: {
                  label: action.label,
                  onClick: () => {
                    action.onClick?.();
                  },
                },
              }
            : {}),
        });

        return String(id);
      },
      dismiss: (id) => {
        toast.dismiss(id);
      },
    }),
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <Toaster position="bottom-right" closeButton />
    </ToastContext.Provider>
  );
}

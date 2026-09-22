import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { cn } from "./lib/utils.ts";
import { useIsMobile } from "./hooks/use-mobile.ts";
import { Icon } from "./icon.tsx";
import { Sheet } from "./dialog.tsx";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_ICON = "3.25rem";

export type SidebarState = "expanded" | "collapsed";

export type SidebarContextValue = {
  readonly state: SidebarState;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly openMobile: boolean;
  readonly setOpenMobile: (open: boolean) => void;
  readonly isMobile: boolean;
  readonly toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);

  if (value === null) {
    throw new Error("useSidebar must be used below a SidebarProvider.");
  }

  return value;
}

export type SidebarProviderProps = {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * Each provider keeps its own key, so the shell's two sidebars — the rail on
   * the left and the inspector on the right — hold independent state and one
   * cannot collapse the other.
   */
  readonly storageKey?: string;
};

export function SidebarProvider({
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  storageKey = "sidebar",
}: SidebarProviderProps) {
  const isMobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => {
    if (controlledOpen !== undefined) {
      return controlledOpen;
    }
    if (typeof window === "undefined") {
      return defaultOpen;
    }
    return window.localStorage.getItem(`porkbot.${storageKey}`) !== "collapsed";
  });
  const [openMobile, setOpenMobile] = useState(false);

  const open = controlledOpen ?? uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) {
        setUncontrolledOpen(next);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            `porkbot.${storageKey}`,
            next ? "expanded" : "collapsed",
          );
        }
      }
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange, storageKey],
  );

  const toggleSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile((value) => !value);
      return;
    }
    setOpen(!open);
  }, [isMobile, open, setOpen]);

  useEffect(() => {
    if (!isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile]);

  const state: SidebarState = open ? "expanded" : "collapsed";

  const value = useMemo<SidebarContextValue>(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [isMobile, open, openMobile, setOpen, state, toggleSidebar],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export type SidebarProps = {
  readonly children: ReactNode;
  readonly side?: "left" | "right";
  readonly collapsible?: "offcanvas" | "icon" | "none";
  readonly className?: string;
};

/**
 * A side rail. On desktop it is a landmark beside the content and collapses to
 * an icon strip; on mobile it is a `Sheet` that opens over the content. The
 * shell mounts two of these — `side="left"` for the rail and `side="right"`
 * under its own provider for the inspector.
 */
export function Sidebar({
  children,
  side = "left",
  collapsible = "icon",
  className,
}: SidebarProps) {
  const { isMobile, openMobile, setOpenMobile, state } = useSidebar();

  if (isMobile) {
    return (
      <Sheet
        open={openMobile}
        onClose={() => {
          setOpenMobile(false);
        }}
        title="Navigation"
      >
        <div data-sidebar="sidebar" data-state={state} className="flex h-full flex-col">
          {children}
        </div>
      </Sheet>
    );
  }

  return (
    <aside
      data-sidebar="sidebar"
      data-state={state}
      data-side={side}
      data-collapsible={collapsible}
      className={cn(
        "flex h-svh shrink-0 flex-col border-border bg-sidebar text-sidebar-foreground",
        side === "left" ? "border-r" : "border-l",
        collapsible === "icon" && state === "collapsed"
          ? "w-(--sidebar-width-icon)"
          : "w-(--sidebar-width)",
        className,
      )}
      style={
        {
          "--sidebar-width": SIDEBAR_WIDTH,
          "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
        } as React.CSSProperties
      }
    >
      {children}
    </aside>
  );
}

export function SidebarHeader({ children, className }: Readonly<{ children?: ReactNode; className?: string }>) {
  return <div data-sidebar="header" className={cn("flex flex-col gap-2 p-2", className)}>{children}</div>;
}

export function SidebarContent({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <div data-sidebar="content" className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto", className)}>
      {children}
    </div>
  );
}

export function SidebarFooter({ children, className }: Readonly<{ children?: ReactNode; className?: string }>) {
  return <div data-sidebar="footer" className={cn("flex flex-col gap-2 p-2", className)}>{children}</div>;
}

export function SidebarGroup({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <section data-sidebar="group" className={cn("flex flex-col gap-1 p-2", className)}>{children}</section>;
}

export function SidebarGroupLabel({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <h3 data-sidebar="group-label" className={cn("px-2 text-xs font-medium text-muted-foreground uppercase", className)}>
      {children}
    </h3>
  );
}

export function SidebarGroupContent({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div data-sidebar="group-content" className={cn("flex flex-col gap-1", className)}>{children}</div>;
}

export function SidebarMenu({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <ul data-sidebar="menu" className={cn("flex flex-col gap-1", className)}>{children}</ul>;
}

export function SidebarMenuItem({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <li data-sidebar="menu-item" className={cn("list-none", className)}>{children}</li>;
}

export type SidebarMenuButtonProps = {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly isActive?: boolean;
  readonly className?: string;
};

export function SidebarMenuButton({ children, onClick, isActive = false, className }: SidebarMenuButtonProps) {
  return (
    <button
      type="button"
      aria-current={isActive ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        isActive && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The grab handle that collapses the sidebar to its icon width. */
export function SidebarRail({ className }: Readonly<{ className?: string }>) {
  const { toggleSidebar, state } = useSidebar();

  return (
    <button
      type="button"
      aria-label={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
      onClick={toggleSidebar}
      className={cn(
        "absolute inset-y-0 z-20 hidden w-1 cursor-col-resize",
        "hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring sm:block",
        className,
      )}
    />
  );
}

/** The main region beside the sidebar; a `SidebarTrigger` lives here. */
export function SidebarInset({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <main className={cn("flex min-w-0 flex-1 flex-col", className)}>{children}</main>;
}

export function SidebarTrigger({ className }: Readonly<{ className?: string }>) {
  const { toggleSidebar, state } = useSidebar();

  return (
    <button
      type="button"
      aria-label={state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
      onClick={toggleSidebar}
      className={cn("rounded-md p-1.5 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", className)}
    >
      <Icon name="panel-left" />
    </button>
  );
}

import { Skeleton } from "@porkbot/ui";
import type { ReactNode } from "react";

/**
 * Content-shaped loading states for the web surfaces. The frame keeps its
 * layout while data is in flight, and the label gives assistive technology a
 * useful status without exposing decorative skeleton bars as content.
 */
export function ScreenSkeleton({
  label,
  children,
  className,
}: Readonly<{
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}>) {
  return (
    <section
      className={["mx-auto flex w-full max-w-2xl flex-col gap-3", className].filter(Boolean).join("")}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </section>
  );
}

function SkeletonHeader({ action = true }: Readonly<{ readonly action?: boolean }>) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Skeleton width="9rem" height="1.5rem" />
      {action ? <Skeleton width="7rem" height="2.25rem" /> : null}
    </div>
  );
}

function SkeletonCard({ lines = 3 }: Readonly<{ readonly lines?: number }>) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <Skeleton width="42%" height="1rem" />
      <Skeleton lines={lines} height="0.75rem" />
    </div>
  );
}

function SkeletonList({ count = 2 }: Readonly<{ readonly count?: number }>) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}

export function RosterSkeleton() {
  return (
    <ScreenSkeleton label="Loading bots" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function BotOverviewSkeleton() {
  return (
    <ScreenSkeleton label="Loading bot" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonCard lines={2} />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function BotEditorSkeleton() {
  return (
    <ScreenSkeleton label="Loading bot editor" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonCard lines={5} />
      <SkeletonCard lines={4} />
    </ScreenSkeleton>
  );
}

export function ThreadSkeleton() {
  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-3 min-h-0 max-w-none"
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className="flex min-h-8 items-center">
        <Skeleton width="7rem" height="1.75rem" />
      </div>
      <div className="flex flex-col items-start gap-3 p-2">
        <Skeleton width="58%" height="4.5rem" />
        <Skeleton width="72%" height="5.5rem" />
        <Skeleton width="46%" height="3.75rem" />
      </div>
    </section>
  );
}

export function MemorySkeleton() {
  return (
    <ScreenSkeleton label="Loading memory" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function ConnectionsSkeleton() {
  return (
    <ScreenSkeleton label="Loading connections" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonList count={2} />
      <SkeletonCard lines={3} />
    </ScreenSkeleton>
  );
}

export function ComputerSkeleton() {
  return (
    <ScreenSkeleton label="Loading computer" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader action={false} />
      <SkeletonCard lines={2} />
      <SkeletonCard lines={4} />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function SecretsSkeleton() {
  return (
    <ScreenSkeleton label="Loading secrets" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <Skeleton width="14rem" height="2.5rem" />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function McpSkeleton() {
  return (
    <ScreenSkeleton label="Loading MCP servers" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function NotificationsSkeleton() {
  return (
    <ScreenSkeleton label="Loading notifications" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader action={false} />
      <Skeleton lines={2} height="0.75rem" />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function UsageSkeleton() {
  return (
    <ScreenSkeleton label="Loading usage" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <Skeleton lines={2} height="0.75rem" />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function ApprovalsSkeleton() {
  return (
    <ScreenSkeleton label="Loading approvals" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader action={false} />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function RoutinesSkeleton() {
  return (
    <ScreenSkeleton label="Loading routines" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function AccountSkeleton() {
  return (
    <ScreenSkeleton label="Loading account" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <SkeletonHeader action={false} />
      <SkeletonCard lines={3} />
    </ScreenSkeleton>
  );
}

export function ToolResultSkeleton() {
  return (
    <ScreenSkeleton label="Loading tool result" className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <Skeleton width="7rem" height="1rem" />
      <Skeleton width="12rem" height="1.75rem" />
      <Skeleton height="16rem" />
    </ScreenSkeleton>
  );
}

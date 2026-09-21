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
      className={["screen-skeleton", className].filter(Boolean).join(" ")}
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
    <div className="screen-skeleton-header">
      <Skeleton width="9rem" height="1.5rem" />
      {action ? <Skeleton width="7rem" height="2.25rem" /> : null}
    </div>
  );
}

function SkeletonCard({ lines = 3 }: Readonly<{ readonly lines?: number }>) {
  return (
    <div className="screen-skeleton-card">
      <Skeleton width="42%" height="1rem" />
      <Skeleton lines={lines} height="0.75rem" />
    </div>
  );
}

function SkeletonList({ count = 2 }: Readonly<{ readonly count?: number }>) {
  return (
    <div className="screen-skeleton-list">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}

export function RosterSkeleton() {
  return (
    <ScreenSkeleton label="Loading bots" className="roster-skeleton">
      <SkeletonHeader />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function BotOverviewSkeleton() {
  return (
    <ScreenSkeleton label="Loading bot" className="bot-overview-skeleton">
      <SkeletonHeader />
      <SkeletonCard lines={2} />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function BotEditorSkeleton() {
  return (
    <ScreenSkeleton label="Loading bot editor" className="bot-editor-skeleton">
      <SkeletonHeader />
      <SkeletonCard lines={5} />
      <SkeletonCard lines={4} />
    </ScreenSkeleton>
  );
}

export function ThreadSkeleton() {
  return (
    <section
      className="console screen-skeleton thread-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <div className="screen-skeleton-strip">
        <Skeleton width="7rem" height="1.75rem" />
      </div>
      <div className="screen-skeleton-messages">
        <Skeleton width="58%" height="4.5rem" />
        <Skeleton width="72%" height="5.5rem" />
        <Skeleton width="46%" height="3.75rem" />
      </div>
    </section>
  );
}

export function MemorySkeleton() {
  return (
    <ScreenSkeleton label="Loading memory" className="memory-skeleton">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function ConnectionsSkeleton() {
  return (
    <ScreenSkeleton label="Loading connections" className="connections-skeleton">
      <SkeletonHeader />
      <SkeletonList count={2} />
      <SkeletonCard lines={3} />
    </ScreenSkeleton>
  );
}

export function ComputerSkeleton() {
  return (
    <ScreenSkeleton label="Loading computer" className="computer-skeleton">
      <SkeletonHeader action={false} />
      <SkeletonCard lines={2} />
      <SkeletonCard lines={4} />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function SecretsSkeleton() {
  return (
    <ScreenSkeleton label="Loading secrets" className="secrets-skeleton">
      <SkeletonHeader />
      <Skeleton width="14rem" height="2.5rem" />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function McpSkeleton() {
  return (
    <ScreenSkeleton label="Loading MCP servers" className="mcp-skeleton">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function NotificationsSkeleton() {
  return (
    <ScreenSkeleton label="Loading notifications" className="notifications-skeleton">
      <SkeletonHeader action={false} />
      <Skeleton lines={2} height="0.75rem" />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function UsageSkeleton() {
  return (
    <ScreenSkeleton label="Loading usage" className="usage-skeleton">
      <SkeletonHeader />
      <Skeleton lines={2} height="0.75rem" />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function ApprovalsSkeleton() {
  return (
    <ScreenSkeleton label="Loading approvals" className="approvals-skeleton">
      <SkeletonHeader action={false} />
      <SkeletonList count={3} />
    </ScreenSkeleton>
  );
}

export function RoutinesSkeleton() {
  return (
    <ScreenSkeleton label="Loading routines" className="routines-skeleton">
      <SkeletonHeader />
      <SkeletonList count={2} />
    </ScreenSkeleton>
  );
}

export function AccountSkeleton() {
  return (
    <ScreenSkeleton label="Loading account" className="account-skeleton">
      <SkeletonHeader action={false} />
      <SkeletonCard lines={3} />
    </ScreenSkeleton>
  );
}

export function ToolResultSkeleton() {
  return (
    <ScreenSkeleton label="Loading tool result" className="tool-result-skeleton">
      <Skeleton width="7rem" height="1rem" />
      <Skeleton width="12rem" height="1.75rem" />
      <Skeleton height="16rem" />
    </ScreenSkeleton>
  );
}

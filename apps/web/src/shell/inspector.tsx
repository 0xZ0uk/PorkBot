import { Link } from "@tanstack/react-router";
import type { Approval, Bot } from "@porkbot/contracts";
import {
  BotAvatar,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarRail,
  StateChip,
} from "@porkbot/ui";
import type { StateChipState } from "@porkbot/ui";

/**
 * The inspector: the selected bot's context beside the content (slice 13.4;
 * design record, Shell anatomy). It is the shell's right `Sidebar` under its
 * own provider, so collapsing it cannot collapse the rail. It carries the
 * bot's identity, what the shell knows of its state, what is waiting on the
 * operator, and the bot's screens.
 */
export interface InspectorProps {
  readonly bot: Bot;
  readonly state: StateChipState | null;
  readonly pendingApprovals: readonly Approval[];
  /** Closes the inspector sheet after a navigation; absent in the wide pane. */
  readonly onNavigate?: (() => void) | undefined;
}

export function Inspector({ bot, state, pendingApprovals, onNavigate }: InspectorProps) {
  const meta = [bot.title, bot.computerProvider, bot.model].filter(
    (part): part is string => part !== null && part !== "",
  );
  return (
    <Sidebar side="right" collapsible="offcanvas" className="border-l border-border bg-card">
      <SidebarRail />
      <SidebarHeader>
        <div className="flex items-center gap-2">
          <BotAvatar id={bot.id} name={bot.name} color={bot.color} size={32} />
          <span className="flex min-w-0 flex-col">
            <span className="text-heading text-foreground">{bot.name}</span>
            <span className="text-meta text-muted-foreground">
              {meta.length === 0 ? "Bot" : meta.join(" · ")}
            </span>
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>State</SidebarGroupLabel>
          <SidebarGroupContent>
            {state === null ? (
              <p className="text-body text-muted-foreground">No state to show yet.</p>
            ) : (
              <StateChip
                state={state}
                count={state === "waiting" ? pendingApprovals.length : undefined}
              />
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Pending approvals</SidebarGroupLabel>
          <SidebarGroupContent>
            {pendingApprovals.length === 0 ? (
              <p className="text-body text-muted-foreground">Nothing waiting.</p>
            ) : (
              <>
                <p className="text-body">
                  {pendingApprovals.length === 1
                    ? "1 action is waiting for you."
                    : `${String(pendingApprovals.length)} actions are waiting for you.`}
                </p>
                <Link
                  to="/approvals"
                  onClick={onNavigate}
                  className="text-body text-primary hover:underline"
                >
                  Review approvals
                </Link>
              </>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Screens</SidebarGroupLabel>
          <SidebarGroupContent>
            <nav aria-label={`${bot.name} screens`} className="flex flex-col gap-1">
              <Link
                to="/bots/$botId/computer"
                params={{ botId: bot.id }}
                onClick={onNavigate}
                className="text-body text-primary hover:underline"
              >
                Computer
              </Link>
              <Link
                to="/bots/$botId/memory"
                params={{ botId: bot.id }}
                onClick={onNavigate}
                className="text-body text-primary hover:underline"
              >
                Memory
              </Link>
              <Link
                to="/bots/$botId/usage"
                params={{ botId: bot.id }}
                onClick={onNavigate}
                className="text-body text-primary hover:underline"
              >
                Usage
              </Link>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

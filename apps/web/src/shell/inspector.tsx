import { Link } from "@tanstack/react-router";
import type { Approval, Bot } from "@porkbot/contracts";
import { BotAvatar, StateChip } from "@porkbot/ui";
import type { StateChipState } from "@porkbot/ui";

/**
 * The inspector: the selected bot's context beside the content (slice 13.4;
 * design record, Shell anatomy). It carries the bot's identity, what the shell
 * knows of its state, what is waiting on the operator, and the bot's screens.
 * The live screen and routine sections arrive with the slices that own them;
 * this is the pane they will land in.
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
    <div className="shell-inspector-inner">
      <div className="shell-inspector-head">
        <BotAvatar id={bot.id} name={bot.name} color={bot.color} size={32} />
        <span className="shell-inspector-head-body">
          <span className="shell-inspector-head-name">{bot.name}</span>
          <span className="shell-inspector-head-meta">
            {meta.length === 0 ? "Bot" : meta.join(" · ")}
          </span>
        </span>
      </div>

      <section className="shell-inspector-section">
        <h2 className="shell-inspector-title">State</h2>
        {state === null ? (
          <p className="muted">No state to show yet.</p>
        ) : (
          <StateChip
            state={state}
            count={state === "waiting" ? pendingApprovals.length : undefined}
          />
        )}
      </section>

      <section className="shell-inspector-section">
        <h2 className="shell-inspector-title">Pending approvals</h2>
        {pendingApprovals.length === 0 ? (
          <p className="muted">Nothing waiting.</p>
        ) : (
          <>
            <p className="shell-inspector-line">
              {pendingApprovals.length === 1
                ? "1 action is waiting for you."
                : `${String(pendingApprovals.length)} actions are waiting for you.`}
            </p>
            <Link to="/approvals" className="shell-inspector-link" onClick={onNavigate}>
              Review approvals
            </Link>
          </>
        )}
      </section>

      <section className="shell-inspector-section">
        <h2 className="shell-inspector-title">Screens</h2>
        <nav className="shell-inspector-links" aria-label={`${bot.name} screens`}>
          <Link
            to="/bots/$botId/computer"
            params={{ botId: bot.id }}
            className="shell-inspector-link"
            onClick={onNavigate}
          >
            Computer
          </Link>
          <Link
            to="/bots/$botId/memory"
            params={{ botId: bot.id }}
            className="shell-inspector-link"
            onClick={onNavigate}
          >
            Memory
          </Link>
          <Link
            to="/bots/$botId/routines"
            params={{ botId: bot.id }}
            className="shell-inspector-link"
            onClick={onNavigate}
          >
            Routines
          </Link>
          <Link
            to="/bots/$botId/usage"
            params={{ botId: bot.id }}
            className="shell-inspector-link"
            onClick={onNavigate}
          >
            Usage
          </Link>
          <Link
            to="/bots/$botId/edit"
            params={{ botId: bot.id }}
            className="shell-inspector-link"
            onClick={onNavigate}
          >
            Edit
          </Link>
        </nav>
      </section>
    </div>
  );
}

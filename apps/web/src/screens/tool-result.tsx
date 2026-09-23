import { Link } from "@tanstack/react-router";

/**
 * The full value behind one truncated tool event (slice 6.8).
 *
 * The console's timeline shows the bounded preview and links here; this screen
 * is the destination that preview pointed at, fetched through the same
 * actor-scoped API read. It is deliberately nothing more than the name of the
 * tool and the value: an artifact view is for reading and quoting, not for
 * chrome.
 */

export interface ToolResultScreenProps {
  readonly botId: string;
  readonly threadId: string;
  readonly tool: string;
  readonly result: unknown;
}

export function ToolResultScreen({ botId, threadId, tool, result }: ToolResultScreenProps) {
  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <p className="text-muted-foreground">
        <Link to="/bots/$botId/threads/$threadId" params={{ botId, threadId }}>
          Back to thread
        </Link>
      </p>
      <h1 className="text-title">Tool result</h1>
      <p className="text-muted-foreground">{tool}</p>
      <pre className="m-0 wrap-anywhere whitespace-pre-wrap rounded-md border border-border bg-background p-2 font-mono text-code">
        {json(result)}
      </pre>
    </section>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? String(value);
}

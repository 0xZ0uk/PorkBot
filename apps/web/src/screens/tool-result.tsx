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
  readonly threadId: string;
  readonly tool: string;
  readonly result: unknown;
}

export function ToolResultScreen({ threadId, tool, result }: ToolResultScreenProps) {
  return (
    <section className="console">
      <p className="muted">
        <Link to="/threads/$threadId" params={{ threadId }}>
          Back to thread
        </Link>
      </p>
      <h1 className="tool-result-title">Tool result</h1>
      <p className="muted">{tool}</p>
      <pre className="tool-result-json">{json(result)}</pre>
    </section>
  );
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2) ?? String(value);
}

import { NotFoundError } from "@porkbot/effect";
import type { ApprovalHistoryRecord } from "@porkbot/effect";
import { authenticated } from "../gate.ts";

/**
 * The approval router is deliberately thin. The actor-scoped repository owns
 * the compare-and-set vote and the joined history read; this file only turns
 * database dates into the contract's ISO wire values. A decision is read back
 * through the history seam so the response has the same bot/thread deep-link
 * facts as a list row.
 */
export function createApprovalsRouter() {
  const list = authenticated.approvals.list.handler(async ({ input, context }) => ({
    approvals: (await context.repositories.approvals.list(input)).map(approvalView),
  }));

  const decide = authenticated.approvals.decide.handler(async ({ input, context }) => {
    const result = await context.repositories.approvals.decide(
      input.reason === undefined
        ? { runId: input.runId, callId: input.callId, vote: input.vote }
        : { runId: input.runId, callId: input.callId, vote: input.vote, reason: input.reason },
    );
    const rows = await context.repositories.approvals.list({ runId: input.runId });
    const history = rows.find((row) => row.callId === input.callId);

    if (history === undefined) {
      // A real store cannot get here: the compare-and-set and the scoped
      // history read name the same `(run, call)` row. Keeping the assertion at
      // the boundary prevents an incomplete fake or a future store from
      // returning a contract shape with a made-up thread.
      throw new NotFoundError("approval", input.callId);
    }

    return { approval: approvalView(history), applied: result.applied };
  });

  return authenticated.approvals.router({ list, decide });
}

function approvalView(row: ApprovalHistoryRecord) {
  return {
    id: row.id,
    botId: row.botId,
    threadId: row.threadId,
    runId: row.runId,
    callId: row.callId,
    tool: row.tool,
    arguments: row.arguments,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
  };
}

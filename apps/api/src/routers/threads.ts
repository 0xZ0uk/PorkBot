import { withEventMeta } from "@orpc/server";
import { authenticated } from "../gate.ts";
import { messageOutput, threadOutput } from "../services/threads.ts";
import type { ThreadsService } from "../services/threads.ts";
import type { ThreadEventFrame, ThreadEventsService } from "../services/thread-events.ts";

/**
 * The threads router: creation, listing, the transcript, sending, clearing and
 * the SSE subscription.
 *
 * The handlers name a bot, a thread or a message and never a space; the
 * repositories the gate hands them are scoped to the actor's space, and a
 * foreign id arrives at the gate's error boundary as the typed `NOT_FOUND`
 * exactly like a missing one (PRD decision 7). The service owns the decisions
 * — the send policy, the keyset pages, the clear — and this file is transport
 * translation: records become the contract's wire shapes, and every event
 * frame's signed cursor rides the SSE `id`.
 *
 * The subscription handler does two things and no more — it asks the events
 * service to validate the actor's access to the thread and the resume cursor,
 * then frames every delivered event with its signed cursor. Validation
 * throwing before the generator is returned is what keeps a refused subscribe
 * or resume a typed HTTP answer (404/400) instead of an error inside an
 * already-open event stream.
 */
export function createThreadsRouter(events: ThreadEventsService, service: ThreadsService) {
  const create = authenticated.threads.create.handler(async ({ input, context }) =>
    threadOutput(await service.create({ repositories: context.repositories, botId: input.botId })),
  );

  const list = authenticated.threads.list.handler(async ({ input, context }) => {
    const page = await service.list({
      repositories: context.repositories,
      botId: input.botId,
      limit: input.limit,
      after: input.after,
    });

    return { threads: page.threads.map(threadOutput), nextCursor: page.nextCursor };
  });

  const messages = authenticated.threads.messages.handler(async ({ input, context }) => {
    const page = await service.messages({
      repositories: context.repositories,
      threadId: input.threadId,
      limit: input.limit,
      afterSeq: input.afterSeq,
    });

    return { messages: page.messages.map(messageOutput), nextSeq: page.nextSeq };
  });

  const send = authenticated.threads.send.handler(async ({ input, context }) => {
    const outcome = await service.send({
      repositories: context.repositories,
      threadId: input.threadId,
      text: input.text,
      clientNonce: input.clientNonce,
    });

    return {
      action: outcome.action,
      message: messageOutput(outcome.message),
      runId: outcome.runId,
    };
  });

  const clear = authenticated.threads.clear.handler(async ({ input, context }) =>
    threadOutput(
      await service.clear({ repositories: context.repositories, threadId: input.threadId }),
    ),
  );

  const toolResult = authenticated.threads.toolResult.handler(async ({ input, context }) =>
    service.toolResult({
      repositories: context.repositories,
      threadId: input.threadId,
      runId: input.runId,
      callId: input.callId,
    }),
  );

  const subscribe = authenticated.threads.events.handler(
    async ({ input, context, lastEventId, signal }) =>
      frames(
        await events.subscribe({
          actor: context.actor,
          repositories: context.repositories,
          threadId: input.threadId,
          lastEventId,
          signal,
        }),
      ),
  );

  return authenticated.threads.router({
    create,
    list,
    messages,
    send,
    clear,
    toolResult,
    events: subscribe,
  });
}

async function* frames(subscription: AsyncGenerator<ThreadEventFrame>) {
  for await (const frame of subscription) {
    // The cursor is transport metadata, not event data: it rides the SSE `id`
    // so a reconnecting client can send it back as `Last-Event-ID`.
    yield withEventMeta(frame.event, { id: frame.cursor });
  }
}

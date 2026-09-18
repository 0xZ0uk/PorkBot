import { withEventMeta } from "@orpc/server";
import { authenticated } from "../gate.ts";
import type { ThreadEventFrame, ThreadEventsService } from "../services/thread-events.ts";

/**
 * The threads router: one subscription, `threads.events`.
 *
 * The handler does two things and no more — it asks the service to validate
 * the actor's access to the thread and the resume cursor, then frames every
 * delivered event with its signed cursor as the SSE `id`. Validation throwing
 * before the generator is returned is what keeps a refused subscribe or resume
 * a typed HTTP answer (404/400) instead of an error inside an already-open
 * event stream. The service owns the replay loop and the transport flags.
 */
export function createThreadsRouter(service: ThreadEventsService) {
  const events = authenticated.threads.events.handler(
    async ({ input, context, lastEventId, signal }) =>
      frames(
        await service.subscribe({
          actor: context.actor,
          repositories: context.repositories,
          threadId: input.threadId,
          lastEventId,
          signal,
        }),
      ),
  );

  return authenticated.threads.router({ events });
}

async function* frames(subscription: AsyncGenerator<ThreadEventFrame>) {
  for await (const frame of subscription) {
    // The cursor is transport metadata, not event data: it rides the SSE `id`
    // so a reconnecting client can send it back as `Last-Event-ID`.
    yield withEventMeta(frame.event, { id: frame.cursor });
  }
}

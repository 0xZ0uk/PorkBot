import type { MemoryDocumentRecord, MemoryRevisionRecord, MemoryWriteOutcome } from "@porkbot/db";
import type {
  MemoryDocumentView,
  MemoryRevisionView,
  MemoryWriteOutcomeView,
} from "@porkbot/contracts";
import { authenticated } from "../gate.ts";

/**
 * The memory router (slice 8.3, PRD decision 21; stories 23 and 24): the
 * operator's read, edit, delete and restore over the store slice 8.1 landed.
 *
 * Every handler is one call on the actor-scoped store, and the store binds the
 * space: a document in another space is an empty history or a scoped refusal,
 * never a confirmation that the id exists elsewhere. A memory decision is a
 * value, not an exception — an update that repeats the current state is
 * `no_change`, a rewrite of a deleted document names the rule it broke — so the
 * router maps that outcome to the contract's union instead of catching a
 * thrown error. The one thing it does not do is compose: restore is the
 * store's own operation, reading the target revision inside the statement that
 * reapplies it, so a router can never reconstruct history from a read and a
 * write.
 *
 * The record-to-output mapping is transport translation and nothing more: ISO
 * instants for the wire, the deletion instant filled in as `null` for a live
 * document, and the domain error's class name and sentence carried as the
 * refusal. No handler chooses an origin or an author, names a space, or
 * inspects a raw error; those are the store's and the gate's business.
 */
export function createMemoryRouter() {
  const list = authenticated.memory.list.handler(async ({ input, context }) => {
    if (input.scope === "deleted") {
      const records = await context.repositories.memory.listDeleted(input.botId);

      return { documents: records.map(deletedDocumentOutput) };
    }

    const documents = await context.repositories.memory.list(input.botId);

    return {
      documents: documents.map((document): MemoryDocumentView => ({
        ...document,
        deletedAt: null,
      })),
    };
  });

  const revisions = authenticated.memory.revisions.handler(async ({ input, context }) => {
    const records = await context.repositories.memory.revisions(input.botId, input.documentId);

    return { revisions: records.map(revisionOutput) };
  });

  const update = authenticated.memory.update.handler(async ({ input, context }) => {
    const outcome = await context.repositories.memory.write(input.botId, {
      write: {
        action: "update",
        documentId: input.documentId,
        title: input.title,
        content: input.content,
      },
      reason: input.reason,
    });

    return outcomeOutput(outcome);
  });

  const remove = authenticated.memory.remove.handler(async ({ input, context }) => {
    const outcome = await context.repositories.memory.write(input.botId, {
      write: { action: "delete", documentId: input.documentId },
      reason: input.reason,
    });

    return outcomeOutput(outcome);
  });

  const restore = authenticated.memory.restore.handler(async ({ input, context }) => {
    const outcome = await context.repositories.memory.restore(
      input.botId,
      input.documentId,
      input.revision,
      input.reason,
    );

    return outcomeOutput(outcome);
  });

  return authenticated.memory.router({ list, revisions, update, remove, restore });
}

function deletedDocumentOutput(record: MemoryDocumentRecord): MemoryDocumentView {
  return {
    documentId: record.documentId,
    kind: record.kind,
    title: record.title,
    content: record.content,
    revision: record.revision,
    deletedAt: record.deletedAt,
  };
}

function revisionOutput(record: MemoryRevisionRecord): MemoryRevisionView {
  return {
    documentId: record.documentId,
    revision: record.revision,
    origin: record.origin,
    author: record.author,
    reason: record.reason,
    kind: record.kind,
    title: record.title,
    content: record.content,
    deleted: record.deleted,
    createdAt: record.createdAt,
  };
}

/**
 * A decision as the client reads it. A refusal keeps the rule's own name and
 * sentence: "history is an operator act" is the recovery hint, and the rule's
 * text carries no secret. `no_change` is a success with nothing written.
 */
function outcomeOutput(outcome: MemoryWriteOutcome): MemoryWriteOutcomeView {
  if (!outcome.ok) {
    return { ok: false, rule: outcome.error.name, message: outcome.error.message };
  }

  if (outcome.action === "no_change") {
    return { ok: true, action: "no_change" };
  }

  return { ok: true, action: outcome.action, revision: revisionOutput(outcome.revision) };
}

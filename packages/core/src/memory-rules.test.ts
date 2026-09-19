import { describe, expect, it } from "vitest";
import {
  AgentCannotDeleteMemory,
  AgentCannotRestoreMemory,
  decideMemoryRestore,
  decideMemoryWrite,
  EmptyMemoryContent,
  EmptyMemoryTitle,
  MAX_MEMORY_CONTENT_LENGTH,
  MAX_MEMORY_DOCUMENT_ID_LENGTH,
  MAX_MEMORY_DOCUMENTS_PER_BOT,
  MAX_MEMORY_REASON_LENGTH,
  MAX_MEMORY_TITLE_LENGTH,
  MEMORY_KINDS,
  MEMORY_WRITE_ORIGINS,
  MemoryContentTooLong,
  MemoryDocumentExists,
  MemoryDocumentIdTooLong,
  MemoryDocumentLimitReached,
  MemoryReasonTooLong,
  MemoryRuleError,
  MemoryTitleTooLong,
  MissingMemoryAuthor,
  MissingMemoryDocumentId,
  MissingMemoryReason,
  UnknownMemoryAction,
  UnknownMemoryDocument,
  UnknownMemoryKind,
  UnknownMemoryOrigin,
  UnknownMemoryRevision,
  isMemoryKind,
  isMemoryWriteOrigin,
} from "./memory-rules.ts";
import type {
  MemoryDocument,
  MemoryKind,
  MemoryRestoreContext,
  MemoryRestoreRequest,
  MemoryRevision,
  MemoryWrite,
  MemoryWriteContext,
  MemoryWriteRequest,
} from "./memory-rules.ts";

const existing: MemoryDocument = {
  documentId: "doc-1",
  kind: "preference",
  title: "Reporting cadence",
  content: "Send the weekly report on Friday",
  revision: 3,
};

const deliberate = { origin: "deliberate", author: "operator-1", reason: "user asked" } as const;

function createWrite(
  overrides: Partial<Extract<MemoryWrite, { action: "create" }>> = {},
): MemoryWrite {
  return {
    action: "create",
    documentId: "doc-new",
    kind: "fact",
    title: "Timezone",
    content: "The operator is in UTC+1",
    ...overrides,
  };
}

function updateWrite(
  overrides: Partial<Extract<MemoryWrite, { action: "update" }>> = {},
): MemoryWrite {
  return {
    action: "update",
    documentId: existing.documentId,
    title: existing.title,
    content: "Send the weekly report on Thursday",
    ...overrides,
  };
}

function writeRequest(write: MemoryWrite, overrides: Partial<MemoryWriteRequest> = {}) {
  return { ...deliberate, write, ...overrides } satisfies MemoryWriteRequest;
}

function context(overrides: Partial<MemoryWriteContext> = {}): MemoryWriteContext {
  return { document: existing, documentCount: 1, ...overrides };
}

function failure(request: MemoryWriteRequest, ctx: MemoryWriteContext = context()) {
  const decision = decideMemoryWrite(request, ctx);
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    throw new Error("expected the write to be refused");
  }

  return decision.error;
}

function changed(request: MemoryWriteRequest, ctx: MemoryWriteContext = context()) {
  const decision = decideMemoryWrite(request, ctx);
  if (!decision.ok) {
    throw new Error(`expected the write to be allowed, got ${decision.error.name}`);
  }
  if (decision.action === "no_change") {
    throw new Error("expected a change, got no_change");
  }

  return decision;
}

describe("decideMemoryWrite create", () => {
  it("creates revision 1 and records who and why", () => {
    const { action, revision } = changed(writeRequest(createWrite()), {
      documentCount: 0,
    });

    expect(action).toBe("create");
    expect(revision).toEqual({
      documentId: "doc-new",
      revision: 1,
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      kind: "fact",
      title: "Timezone",
      content: "The operator is in UTC+1",
      deleted: false,
    });
  });

  it("accepts every declared memory kind", () => {
    for (const kind of MEMORY_KINDS) {
      const { revision } = changed(writeRequest(createWrite({ kind })), { documentCount: 0 });
      expect(revision.kind).toBe(kind);
    }
  });

  it("allows an agent-proposed create, recording the origin", () => {
    const request = writeRequest(createWrite(), {
      origin: "agent_proposed",
      author: "bot-1",
      reason: "agent remembered a fact",
    });

    const { revision } = changed(request, { documentCount: 0 });
    expect(revision.origin).toBe("agent_proposed");
    expect(revision.author).toBe("bot-1");
    expect(revision.reason).toBe("agent remembered a fact");
  });

  it("allows the last slot below the count limit and refuses the one at it", () => {
    const below = changed(writeRequest(createWrite()), {
      documentCount: MAX_MEMORY_DOCUMENTS_PER_BOT - 1,
    });
    expect(below.revision.revision).toBe(1);

    const error = failure(writeRequest(createWrite()), {
      documentCount: MAX_MEMORY_DOCUMENTS_PER_BOT,
    });
    expect(error).toBeInstanceOf(MemoryDocumentLimitReached);
    if (error instanceof MemoryDocumentLimitReached) {
      expect(error.count).toBe(MAX_MEMORY_DOCUMENTS_PER_BOT);
      expect(error.limit).toBe(MAX_MEMORY_DOCUMENTS_PER_BOT);
    }
  });

  it("refuses to overwrite an existing document, even below the count limit", () => {
    const request = writeRequest(
      createWrite({ documentId: existing.documentId, title: "Overwrite", content: "nope" }),
    );

    const error = failure(request, { document: existing, documentCount: 1 });
    expect(error).toBeInstanceOf(MemoryDocumentExists);
    if (error instanceof MemoryDocumentExists) {
      expect(error.documentId).toBe(existing.documentId);
    }
  });
});

describe("decideMemoryWrite update", () => {
  it("creates the next revision and keeps the document's kind", () => {
    const { action, revision } = changed(writeRequest(updateWrite()));

    expect(action).toBe("update");
    expect(revision).toEqual({
      documentId: existing.documentId,
      revision: existing.revision + 1,
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      kind: existing.kind,
      title: existing.title,
      content: "Send the weekly report on Thursday",
      deleted: false,
    });
  });

  it("records a title-only change", () => {
    const { revision } = changed(writeRequest(updateWrite({ title: "Reporting schedule" })));
    expect(revision.title).toBe("Reporting schedule");
    expect(revision.content).toBe("Send the weekly report on Thursday");
  });

  it("allows an agent-proposed update", () => {
    const request = writeRequest(updateWrite(), {
      origin: "agent_proposed",
      author: "bot-1",
      reason: "agent corrected itself",
    });

    const { revision } = changed(request);
    expect(revision.origin).toBe("agent_proposed");
    expect(revision.revision).toBe(existing.revision + 1);
  });

  it("is no_change when title and content repeat the document exactly", () => {
    const decision = decideMemoryWrite(
      writeRequest(updateWrite({ title: existing.title, content: existing.content })),
      context(),
    );

    expect(decision).toEqual({ ok: true, action: "no_change" });
  });

  it("is not stopped by the create cap, even as a no-op", () => {
    const { action } = changed(writeRequest(updateWrite()), {
      document: existing,
      documentCount: MAX_MEMORY_DOCUMENTS_PER_BOT,
    });
    expect(action).toBe("update");

    const noChange = decideMemoryWrite(
      writeRequest(updateWrite({ title: existing.title, content: existing.content })),
      { document: existing, documentCount: MAX_MEMORY_DOCUMENTS_PER_BOT },
    );
    expect(noChange).toEqual({ ok: true, action: "no_change" });
  });

  it("treats a whitespace-only difference as a change, reserving blank checks for validation", () => {
    const { revision } = changed(writeRequest(updateWrite({ title: ` ${existing.title} ` })));
    expect(revision.title).toBe(` ${existing.title} `);
  });

  it("refuses an update whose target is missing", () => {
    const error = failure(writeRequest(updateWrite()), { documentCount: 1 });
    expect(error).toBeInstanceOf(UnknownMemoryDocument);
    if (error instanceof UnknownMemoryDocument) {
      expect(error.documentId).toBe(existing.documentId);
    }
  });
});

describe("decideMemoryWrite delete", () => {
  it("creates a tombstone revision carrying the last state", () => {
    const { action, revision } = changed(writeRequest({ action: "delete", documentId: "doc-1" }));

    expect(action).toBe("delete");
    expect(revision).toEqual({
      documentId: "doc-1",
      revision: existing.revision + 1,
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      kind: existing.kind,
      title: existing.title,
      content: existing.content,
      deleted: true,
    });
  });

  it("refuses an agent-proposed delete even when the target exists", () => {
    const request = writeRequest(
      { action: "delete", documentId: existing.documentId },
      { origin: "agent_proposed", author: "bot-1", reason: "agent forgot" },
    );

    const error = failure(request);
    expect(error).toBeInstanceOf(AgentCannotDeleteMemory);
    if (error instanceof AgentCannotDeleteMemory) {
      expect(error.documentId).toBe(existing.documentId);
    }
  });

  it("refuses an agent-proposed delete as a rule, before the target is looked up", () => {
    const request = writeRequest(
      { action: "delete", documentId: "doc-missing" },
      { origin: "agent_proposed", author: "bot-1", reason: "agent forgot" },
    );

    const error = failure(request, { documentCount: 0 });
    expect(error).toBeInstanceOf(AgentCannotDeleteMemory);
  });

  it("refuses a deliberate delete of a missing document", () => {
    const error = failure(writeRequest({ action: "delete", documentId: "doc-missing" }), {
      documentCount: 0,
    });
    expect(error).toBeInstanceOf(UnknownMemoryDocument);
  });
});

describe("memory write validation", () => {
  it("refuses a blank or non-string title", () => {
    for (const title of ["", " ", "\n\t  \n", 42 as unknown as string]) {
      expect(failure(writeRequest(createWrite({ title })), { documentCount: 0 })).toBeInstanceOf(
        EmptyMemoryTitle,
      );
    }
  });

  it("bounds the title length inclusively", () => {
    const atLimit = changed(
      writeRequest(createWrite({ title: "t".repeat(MAX_MEMORY_TITLE_LENGTH) })),
      { documentCount: 0 },
    );
    expect(atLimit.revision.title.length).toBe(MAX_MEMORY_TITLE_LENGTH);

    const error = failure(
      writeRequest(createWrite({ title: "t".repeat(MAX_MEMORY_TITLE_LENGTH + 1) })),
      { documentCount: 0 },
    );
    expect(error).toBeInstanceOf(MemoryTitleTooLong);
    if (error instanceof MemoryTitleTooLong) {
      expect(error.length).toBe(MAX_MEMORY_TITLE_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_MEMORY_TITLE_LENGTH);
    }
  });

  it("refuses blank or non-string content", () => {
    for (const content of ["", "   ", null as unknown as string]) {
      expect(failure(writeRequest(createWrite({ content })), { documentCount: 0 })).toBeInstanceOf(
        EmptyMemoryContent,
      );
    }
  });

  it("bounds the content length inclusively", () => {
    const atLimit = changed(
      writeRequest(createWrite({ content: "c".repeat(MAX_MEMORY_CONTENT_LENGTH) })),
      { documentCount: 0 },
    );
    expect(atLimit.revision.content.length).toBe(MAX_MEMORY_CONTENT_LENGTH);

    const error = failure(
      writeRequest(createWrite({ content: "c".repeat(MAX_MEMORY_CONTENT_LENGTH + 1) })),
      { documentCount: 0 },
    );
    expect(error).toBeInstanceOf(MemoryContentTooLong);
    if (error instanceof MemoryContentTooLong) {
      expect(error.length).toBe(MAX_MEMORY_CONTENT_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_MEMORY_CONTENT_LENGTH);
    }
  });

  it("refuses a missing author", () => {
    for (const author of ["", "   ", 42 as unknown as string, undefined as unknown as string]) {
      expect(failure(writeRequest(createWrite(), { author }), { documentCount: 0 })).toBeInstanceOf(
        MissingMemoryAuthor,
      );
    }
  });

  it("refuses a missing reason", () => {
    for (const reason of ["", "   ", null as unknown as string, undefined as unknown as string]) {
      expect(failure(writeRequest(createWrite(), { reason }), { documentCount: 0 })).toBeInstanceOf(
        MissingMemoryReason,
      );
    }
  });

  it("bounds the reason length inclusively", () => {
    const atLimit = writeRequest(createWrite(), { reason: "r".repeat(MAX_MEMORY_REASON_LENGTH) });
    expect(changed(atLimit, { documentCount: 0 }).action).toBe("create");

    const error = failure(
      writeRequest(createWrite(), { reason: "r".repeat(MAX_MEMORY_REASON_LENGTH + 1) }),
      { documentCount: 0 },
    );
    expect(error).toBeInstanceOf(MemoryReasonTooLong);
    if (error instanceof MemoryReasonTooLong) {
      expect(error.length).toBe(MAX_MEMORY_REASON_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_MEMORY_REASON_LENGTH);
    }
  });

  it("refuses an unknown kind", () => {
    const error = failure(writeRequest(createWrite({ kind: "note" as unknown as MemoryKind })), {
      documentCount: 0,
    });
    expect(error).toBeInstanceOf(UnknownMemoryKind);
    if (error instanceof UnknownMemoryKind) {
      expect(error.value).toBe("note");
    }
  });

  it("refuses an unknown origin", () => {
    const request = writeRequest(createWrite(), {
      origin: "system" as unknown as MemoryWriteRequest["origin"],
    });

    const error = failure(request, { documentCount: 0 });
    expect(error).toBeInstanceOf(UnknownMemoryOrigin);
  });

  it("refuses an unknown action", () => {
    const write = {
      action: "archive",
      documentId: "doc-1",
    } as unknown as MemoryWrite;

    const error = failure(writeRequest(write));
    expect(error).toBeInstanceOf(UnknownMemoryAction);
    if (error instanceof UnknownMemoryAction) {
      expect(error.value).toBe("archive");
    }
  });

  it("refuses a missing document id on every action", () => {
    const creates = writeRequest(createWrite({ documentId: "  " }));
    expect(failure(creates, { documentCount: 0 })).toBeInstanceOf(MissingMemoryDocumentId);

    expect(failure(writeRequest(updateWrite({ documentId: "" })))).toBeInstanceOf(
      MissingMemoryDocumentId,
    );

    expect(
      failure(
        writeRequest({
          action: "delete",
          documentId: 7 as unknown as string,
        }),
      ),
    ).toBeInstanceOf(MissingMemoryDocumentId);
  });

  it("bounds the document id length inclusively", () => {
    const atLimit = changed(
      writeRequest(createWrite({ documentId: "d".repeat(MAX_MEMORY_DOCUMENT_ID_LENGTH) })),
      { documentCount: 0 },
    );
    expect(atLimit.revision.documentId.length).toBe(MAX_MEMORY_DOCUMENT_ID_LENGTH);

    const error = failure(
      writeRequest(createWrite({ documentId: "d".repeat(MAX_MEMORY_DOCUMENT_ID_LENGTH + 1) })),
      { documentCount: 0 },
    );
    expect(error).toBeInstanceOf(MemoryDocumentIdTooLong);
    if (error instanceof MemoryDocumentIdTooLong) {
      expect(error.length).toBe(MAX_MEMORY_DOCUMENT_ID_LENGTH + 1);
      expect(error.maxLength).toBe(MAX_MEMORY_DOCUMENT_ID_LENGTH);
    }
  });

  it("validates before it looks at the count limit", () => {
    const request = writeRequest(createWrite(), { reason: "  " });
    const error = failure(request, { documentCount: MAX_MEMORY_DOCUMENTS_PER_BOT });
    expect(error).toBeInstanceOf(MissingMemoryReason);
  });

  it("checks the create kind before the document content", () => {
    const request = writeRequest(
      createWrite({ kind: "note" as unknown as MemoryKind, title: "  " }),
    );
    expect(failure(request, { documentCount: 0 })).toBeInstanceOf(UnknownMemoryKind);
  });

  it("rejects a documentCount that is not a non-negative safe integer", () => {
    for (const documentCount of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1" as unknown as number,
      undefined as unknown as number,
    ]) {
      expect(() => decideMemoryWrite(writeRequest(createWrite()), { documentCount })).toThrow(
        RangeError,
      );
    }
  });

  it("does not mutate its inputs", () => {
    const frozenWrite = Object.freeze(createWrite());
    const frozenRequest: MemoryWriteRequest = Object.freeze({
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      write: frozenWrite,
    });
    const frozenContext: MemoryWriteContext = Object.freeze({
      document: Object.freeze({ ...existing }),
      documentCount: 1,
    });

    expect(() => decideMemoryWrite(frozenRequest, frozenContext)).not.toThrow();

    const update = Object.freeze(updateWrite());
    const frozenUpdate: MemoryWriteRequest = Object.freeze({
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      write: update,
    });

    expect(() => decideMemoryWrite(frozenUpdate, frozenContext)).not.toThrow();
  });

  it("is deterministic for the same request and context", () => {
    const request = writeRequest(updateWrite());
    expect(decideMemoryWrite(request, context())).toEqual(decideMemoryWrite(request, context()));
  });

  it("names the rule each error broke", () => {
    const errors: readonly MemoryRuleError[] = [
      new EmptyMemoryTitle(),
      new MemoryTitleTooLong(MAX_MEMORY_TITLE_LENGTH + 1),
      new EmptyMemoryContent(),
      new MemoryContentTooLong(MAX_MEMORY_CONTENT_LENGTH + 1),
      new MissingMemoryDocumentId(),
      new MemoryDocumentIdTooLong(MAX_MEMORY_DOCUMENT_ID_LENGTH + 1),
      new MemoryDocumentExists("doc-1"),
      new MissingMemoryAuthor(),
      new MissingMemoryReason(),
      new MemoryReasonTooLong(MAX_MEMORY_REASON_LENGTH + 1),
      new UnknownMemoryKind("note"),
      new UnknownMemoryOrigin("system"),
      new UnknownMemoryAction("archive"),
      new UnknownMemoryDocument("doc-1"),
      new AgentCannotDeleteMemory("doc-1"),
      new UnknownMemoryRevision("doc-1", 9),
      new AgentCannotRestoreMemory("doc-1"),
      new MemoryDocumentLimitReached(MAX_MEMORY_DOCUMENTS_PER_BOT),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(MemoryRuleError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(error.constructor.name);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe("memory predicates", () => {
  it("recognizes the declared kinds and nothing else", () => {
    for (const kind of MEMORY_KINDS) {
      expect(isMemoryKind(kind)).toBe(true);
    }

    for (const value of ["note", "", 1, null, undefined, {}]) {
      expect(isMemoryKind(value)).toBe(false);
    }
  });

  it("recognizes the declared write origins and nothing else", () => {
    for (const origin of MEMORY_WRITE_ORIGINS) {
      expect(isMemoryWriteOrigin(origin)).toBe(true);
    }

    for (const value of ["system", "", 0, null, undefined, []]) {
      expect(isMemoryWriteOrigin(value)).toBe(false);
    }
  });
});

const earlier: MemoryRevision = {
  documentId: existing.documentId,
  revision: 1,
  origin: "deliberate",
  author: "operator-1",
  reason: "first write",
  kind: "preference",
  title: "Reporting cadence",
  content: "Send the weekly report on Monday",
  deleted: false,
};

const tombstone: MemoryRevision = {
  documentId: existing.documentId,
  revision: 4,
  origin: "deliberate",
  author: "operator-1",
  reason: "no longer relevant",
  kind: "preference",
  title: "Reporting cadence",
  content: "Send the weekly report on Friday",
  deleted: true,
};

function restoreRequest(overrides: Partial<MemoryRestoreRequest> = {}): MemoryRestoreRequest {
  return {
    ...deliberate,
    documentId: existing.documentId,
    revision: earlier.revision,
    ...overrides,
  };
}

function restoreContext(overrides: Partial<MemoryRestoreContext> = {}): MemoryRestoreContext {
  return { document: { ...existing, deleted: false }, revision: earlier, ...overrides };
}

function restoreFailure(
  request: MemoryRestoreRequest,
  ctx: MemoryRestoreContext = restoreContext(),
) {
  const decision = decideMemoryRestore(request, ctx);
  expect(decision.ok).toBe(false);
  if (decision.ok) {
    throw new Error("expected the restore to be refused");
  }

  return decision.error;
}

function restored(request: MemoryRestoreRequest, ctx: MemoryRestoreContext = restoreContext()) {
  const decision = decideMemoryRestore(request, ctx);
  if (!decision.ok) {
    throw new Error(`expected the restore to be allowed, got ${decision.error.name}`);
  }
  if (decision.action === "no_change") {
    throw new Error("expected a restore, got no_change");
  }

  return decision;
}

describe("decideMemoryRestore", () => {
  it("reapplies the named revision as the next revision and records who and why", () => {
    const decision = restored(restoreRequest());

    expect(decision.action).toBe("restore");
    expect(decision.revision).toEqual({
      documentId: existing.documentId,
      revision: existing.revision + 1,
      origin: "deliberate",
      author: "operator-1",
      reason: "user asked",
      kind: earlier.kind,
      title: earlier.title,
      content: earlier.content,
      deleted: false,
    });
  });

  it("reverses a deletion by restoring the tombstone revision", () => {
    const document = { ...existing, revision: 4, deleted: true };
    const decision = restored(
      restoreRequest({ revision: tombstone.revision }),
      restoreContext({ document, revision: tombstone }),
    );

    expect(decision.revision.revision).toBe(5);
    expect(decision.revision.deleted).toBe(false);
    expect(decision.revision.content).toBe(tombstone.content);
  });

  it("keeps the target's kind even when a rewrite changed nothing else", () => {
    const decision = restored(restoreRequest(), restoreContext());

    expect(decision.revision.kind).toBe(earlier.kind);
  });

  it("restores the target revision's kind, not the document's", () => {
    const decision = restored(
      restoreRequest({ revision: 2 }),
      restoreContext({
        document: { ...existing, revision: 2, kind: "decision", deleted: false },
        revision: { ...earlier, revision: 2, kind: "fact" },
      }),
    );

    expect(decision.revision.kind).toBe("fact");
  });

  it("is a change when the target differs only in kind", () => {
    const decision = restored(
      restoreRequest({ revision: 3 }),
      restoreContext({
        document: { ...existing, revision: 3, kind: "preference", deleted: false },
        revision: {
          ...earlier,
          revision: 3,
          kind: "fact",
          title: existing.title,
          content: existing.content,
        },
      }),
    );

    expect(decision.action).toBe("restore");
  });

  it("is a no_change when the target already is the live state", () => {
    const live = { ...existing, revision: 3, deleted: false };
    const decision = decideMemoryRestore(
      restoreRequest({ revision: 3 }),
      restoreContext({
        document: live,
        revision: { ...earlier, revision: 3, title: live.title, content: live.content },
      }),
    );

    expect(decision).toEqual({ ok: true, action: "no_change" });
  });

  it("refuses an agent-proposed restore as a rule, not a lookup miss", () => {
    const error = restoreFailure(restoreRequest({ origin: "agent_proposed" }), {
      document: undefined,
      revision: undefined,
    });

    expect(error).toBeInstanceOf(AgentCannotRestoreMemory);
  });

  it("answers unknown-document when no row holds the id", () => {
    const error = restoreFailure(restoreRequest(), {
      document: undefined,
      revision: earlier,
    });

    expect(error).toBeInstanceOf(UnknownMemoryDocument);
  });

  it("answers unknown-revision when history has no such revision", () => {
    expect(
      restoreFailure(restoreRequest(), restoreContext({ revision: undefined })),
    ).toBeInstanceOf(UnknownMemoryRevision);

    expect(
      restoreFailure(restoreRequest(), restoreContext({ revision: { ...earlier, revision: 2 } })),
    ).toBeInstanceOf(UnknownMemoryRevision);

    expect(
      restoreFailure(
        restoreRequest(),
        restoreContext({ revision: { ...earlier, documentId: "doc-other" } }),
      ),
    ).toBeInstanceOf(UnknownMemoryRevision);
  });

  it("validates the request before the document or the history", () => {
    expect(
      restoreFailure(restoreRequest({ reason: "  " }), {
        document: undefined,
        revision: undefined,
      }),
    ).toBeInstanceOf(MissingMemoryReason);

    expect(
      restoreFailure(restoreRequest({ documentId: "  " }), {
        document: undefined,
        revision: undefined,
      }),
    ).toBeInstanceOf(MissingMemoryDocumentId);

    expect(
      restoreFailure(restoreRequest({ revision: 0 }), { document: undefined, revision: undefined }),
    ).toBeInstanceOf(UnknownMemoryRevision);

    expect(
      restoreFailure(restoreRequest({ revision: 1.5 }), {
        document: undefined,
        revision: undefined,
      }),
    ).toBeInstanceOf(UnknownMemoryRevision);

    expect(
      restoreFailure(restoreRequest({ author: "  " }), {
        document: undefined,
        revision: undefined,
      }),
    ).toBeInstanceOf(MissingMemoryAuthor);

    expect(
      restoreFailure(restoreRequest({ reason: "r".repeat(MAX_MEMORY_REASON_LENGTH + 1) }), {
        document: undefined,
        revision: undefined,
      }),
    ).toBeInstanceOf(MemoryReasonTooLong);
  });

  it("does not mutate its inputs", () => {
    const frozenRequest: MemoryRestoreRequest = Object.freeze(restoreRequest());
    const frozenContext: MemoryRestoreContext = Object.freeze({
      document: Object.freeze({ ...existing, deleted: false }),
      revision: Object.freeze({ ...earlier }),
    });

    expect(() => decideMemoryRestore(frozenRequest, frozenContext)).not.toThrow();
  });

  it("is deterministic for the same request and context", () => {
    expect(decideMemoryRestore(restoreRequest(), restoreContext())).toEqual(
      decideMemoryRestore(restoreRequest(), restoreContext()),
    );
  });
});

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { MemoryDocumentView, MemoryRevisionView } from "@porkbot/contracts";

/**
 * A memory API for the e2e suite: a real HTTP server that speaks oRPC's RPC
 * wire by hand, on port 0, with no database and no keys.
 *
 * The suite is about edit-and-persist over a real socket, so the server holds
 * the documents in memory and applies the same decisions the durable store
 * does: a correction advances the revision, a removal tombstones the document
 * and keeps the last state, and a restore reapplies a recorded revision. The
 * "persistence" the reload test observes is this server's state surviving the
 * client unmount, which is what a real API's rows would do.
 */

export interface ScriptedMemoryApi {
  /** The origin, e.g. `http://127.0.0.1:41234`, suitable for a transport. */
  readonly url: string;
  readonly rpcUrl: string;
  /** Every RPC path the server answered, in order. */
  readonly calls: string[];
  close(): Promise<void>;
}

export interface ScriptedMemoryApiOptions {
  readonly botId: string;
  readonly documents?: readonly MemoryDocumentView[];
  readonly revisions?: Readonly<Record<string, readonly MemoryRevisionView[]>>;
}

export async function startScriptedMemoryApi(
  options: ScriptedMemoryApiOptions,
): Promise<ScriptedMemoryApi> {
  const documents: MemoryDocumentView[] = [...(options.documents ?? [])].map((document) => ({
    ...document,
  }));
  const history = new Map<string, MemoryRevisionView[]>(
    Object.entries(options.revisions ?? {}).map(([documentId, revisions]) => [
      documentId,
      revisions.map((revision) => ({ ...revision })),
    ]),
  );
  const calls: string[] = [];

  function revisionsFor(documentId: string): MemoryRevisionView[] {
    const existing = history.get(documentId);

    if (existing !== undefined) {
      return existing;
    }

    const created: MemoryRevisionView[] = [];
    history.set(documentId, created);
    return created;
  }

  function writeJson(response: ServerResponse, value: unknown): void {
    const body = JSON.stringify({ json: value });

    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }

  function stringField(input: unknown, field: string): string {
    return typeof input === "object" && input !== null
      ? String((input as Record<string, unknown>)[field] ?? "")
      : "";
  }

  function numberField(input: unknown, field: string): number {
    return typeof input === "object" && input !== null
      ? Number((input as Record<string, unknown>)[field] ?? 0)
      : 0;
  }

  async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    return typeof parsed === "object" && parsed !== null
      ? (parsed as { json?: unknown }).json
      : undefined;
  }

  function revision(
    documentId: string,
    document: MemoryDocumentView,
    input: {
      readonly title: string;
      readonly content: string;
      readonly reason: string;
      readonly deleted: boolean;
    },
  ): MemoryRevisionView {
    const record: MemoryRevisionView = {
      documentId,
      revision: document.revision + 1,
      origin: "deliberate",
      author: "user-1",
      reason: input.reason,
      kind: document.kind,
      title: input.title,
      content: input.content,
      deleted: input.deleted,
      createdAt: new Date().toISOString(),
    };

    revisionsFor(documentId).push(record);
    return record;
  }

  function notFound(documentId: string): Record<string, unknown> {
    return {
      ok: false,
      rule: "UnknownMemoryDocument",
      message: `Memory document "${documentId}" does not exist`,
    };
  }

  function handle(input: unknown, path: string): unknown {
    switch (path) {
      case "memory/list": {
        const scope = stringField(input, "scope") === "deleted" ? "deleted" : "active";

        return {
          documents: documents.filter(
            (document) => (scope === "deleted") === (document.deletedAt !== null),
          ),
        };
      }
      case "memory/revisions": {
        const documentId = stringField(input, "documentId");

        return { revisions: revisionsFor(documentId) };
      }
      case "memory/update": {
        const documentId = stringField(input, "documentId");
        const index = documents.findIndex((document) => document.documentId === documentId);
        const current = documents[index];

        if (index === -1 || current === undefined || current.deletedAt !== null) {
          return notFound(documentId);
        }

        const title = stringField(input, "title");
        const content = stringField(input, "content");
        const reason = stringField(input, "reason");

        if (current.title === title && current.content === content) {
          return { ok: true, action: "no_change" };
        }

        const record = revision(documentId, current, {
          title,
          content,
          reason,
          deleted: false,
        });

        documents[index] = { ...current, title, content, revision: record.revision };

        return { ok: true, action: "update", revision: record };
      }
      case "memory/remove": {
        const documentId = stringField(input, "documentId");
        const index = documents.findIndex(
          (document) => document.documentId === documentId && document.deletedAt === null,
        );
        const current = documents[index];

        if (index === -1 || current === undefined) {
          return notFound(documentId);
        }

        const record = revision(documentId, current, {
          title: current.title,
          content: current.content,
          reason: stringField(input, "reason"),
          deleted: true,
        });

        documents[index] = {
          ...current,
          revision: record.revision,
          deletedAt: record.createdAt,
        };

        return { ok: true, action: "delete", revision: record };
      }
      case "memory/restore": {
        const documentId = stringField(input, "documentId");
        const index = documents.findIndex((document) => document.documentId === documentId);
        const current = documents[index];
        const revisionNumber = numberField(input, "revision");
        const target = revisionsFor(documentId).find(
          (candidate) => candidate.revision === revisionNumber,
        );

        if (index === -1 || current === undefined || target === undefined) {
          return {
            ok: false,
            rule: "UnknownMemoryRevision",
            message: `Memory document "${documentId}" has no revision ${String(revisionNumber)}`,
          };
        }

        if (
          current.deletedAt === null &&
          current.title === target.title &&
          current.content === target.content
        ) {
          return { ok: true, action: "no_change" };
        }

        const record = revision(documentId, current, {
          title: target.title,
          content: target.content,
          reason: stringField(input, "reason"),
          deleted: false,
        });

        documents[index] = {
          ...current,
          kind: target.kind,
          title: target.title,
          content: target.content,
          revision: record.revision,
          deletedAt: null,
        };

        return { ok: true, action: "restore", revision: record };
      }
      default:
        return { documents: [] };
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const path = (request.url ?? "").replace("/rpc/", "");
    calls.push(path);

    const input = await readBody(request);
    writeJson(response, handle(input, path));
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }

      response.end(JSON.stringify({ error: "internal_error" }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected the scripted API to listen on a TCP address");
  }

  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    rpcUrl: `${url}/rpc`,
    calls,

    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Message content blocks: the smallest vocabulary a stored message can carry.
 *
 * A message's `blocks` column is jsonb because the wire's content is expected
 * to grow (attachments, artifacts, tool folds), but the nonce rule needs to ask
 * one question of it: *is this the same request the nonce already carried?*
 * That question is answered here, once, so the send path and the replay read
 * cannot disagree about what a message says.
 *
 * Two kinds ship: literal text, and a reference to a stored file the sender
 * attached. A file block names the stored attachment row and the facts a
 * reader needs to render it; the bytes stay behind the storage seam, and the
 * message itself never carries them. Core is the domain vocabulary's owner, so
 * the jsonb read validates both shapes here and an unknown kind poisons the
 * read rather than reaching a caller as an unvalidated object.
 */

import { attachmentWorkspacePath } from "./files.ts";

/** A block of literal text. */
export interface TextMessageBlock {
  readonly type: "text";
  readonly text: string;
}

/**
 * A reference to a stored attachment. The id addresses the attachment row (and
 * through it the stored bytes); the rest is what a renderer needs without a
 * second read. `sizeBytes` is the stored size, not a claim by the uploader.
 */
export interface FileMessageBlock {
  readonly type: "file";
  readonly attachmentId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export type MessageBlock = TextMessageBlock | FileMessageBlock;

/** The blocks one plain-text send produces. */
export function textMessageBlocks(text: string): readonly MessageBlock[] {
  return [{ type: "text", text }];
}

/** The blocks a send with attachments produces: the text first, then each file. */
export function messageBlocksForSend(
  text: string,
  files: readonly FileMessageBlock[],
): readonly MessageBlock[] {
  return [{ type: "text", text }, ...files];
}

export function isTextMessageBlock(value: unknown): value is TextMessageBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return record["type"] === "text" && typeof record["text"] === "string";
}

export function isFileMessageBlock(value: unknown): value is FileMessageBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record["type"] === "file" &&
    typeof record["attachmentId"] === "string" &&
    record["attachmentId"] !== "" &&
    typeof record["filename"] === "string" &&
    record["filename"] !== "" &&
    typeof record["contentType"] === "string" &&
    record["contentType"] !== "" &&
    typeof record["sizeBytes"] === "number" &&
    Number.isSafeInteger(record["sizeBytes"]) &&
    record["sizeBytes"] >= 0
  );
}

/** Whether a value read out of jsonb is a block this build understands. */
export function isMessageBlock(value: unknown): value is MessageBlock {
  return isTextMessageBlock(value) || isFileMessageBlock(value);
}

/**
 * The text a stored message carries, or `undefined` when its blocks are not a
 * shape this build reads. File blocks carry no text and are skipped; a caller
 * comparing a resubmitted nonce treats `undefined` as "not the same request",
 * so an unrecognized block kind can never make two different sends look like a
 * replay.
 */
export function messageText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return undefined;
  }

  const texts: string[] = [];

  for (const block of blocks) {
    if (isTextMessageBlock(block)) {
      texts.push(block.text);
      continue;
    }

    if (!isFileMessageBlock(block)) {
      return undefined;
    }
  }

  return texts.join("");
}

/**
 * The file blocks a stored message carries, in order, or `undefined` when the
 * blocks are not a shape this build reads. The send's replay comparison asks
 * this beside `messageText`: a nonce spent on a different attachment set is a
 * different request, not a replay.
 */
export function messageFiles(blocks: unknown): readonly FileMessageBlock[] | undefined {
  if (!Array.isArray(blocks)) {
    return undefined;
  }

  const files: FileMessageBlock[] = [];

  for (const block of blocks) {
    if (isTextMessageBlock(block)) {
      continue;
    }

    if (!isFileMessageBlock(block)) {
      return undefined;
    }

    files.push(block);
  }

  return files;
}

/**
 * The prompt a message-triggered run carries when the message has attachments:
 * the sender's text plus the deterministic home-relative path each file was
 * materialized at, so the model can read it with the file tools. The file
 * names are the sender's own input, framed as a list rather than as prose.
 */
export function messagePromptWithAttachments(text: string, blocks: unknown): string {
  const files = messageFiles(blocks);

  if (files === undefined || files.length === 0) {
    return text;
  }

  const lines = files.map(
    (file) =>
      `- ${attachmentWorkspacePath(file.attachmentId, file.filename)} ` +
      `(${file.contentType}, ${String(file.sizeBytes)} bytes)`,
  );

  return (
    `${text}\n\n` +
    "Files attached to this message are in the computer's home directory:\n" +
    lines.join("\n")
  );
}

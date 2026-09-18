/**
 * Message content blocks: the smallest vocabulary a stored message can carry.
 *
 * A message's `blocks` column is jsonb because the wire's content is expected
 * to grow (attachments, artifacts, tool folds), but the nonce rule needs to ask
 * one question of it: *is this the same text the nonce already carried?* That
 * question is answered here, once, so the send path and the replay read cannot
 * disagree about what a message says.
 *
 * The block union is deliberately closed at one member. Core is the domain
 * vocabulary's owner and the reducer in this package already treats an unknown
 * shape as a defect; a second block kind arrives here beside the rule that
 * understands it, never as an unvalidated object read straight out of jsonb.
 */

/** A block of literal text. The only block kind the v1.0 composer writes. */
export interface TextMessageBlock {
  readonly type: "text";
  readonly text: string;
}

export type MessageBlock = TextMessageBlock;

/** The blocks one plain-text send produces. */
export function textMessageBlocks(text: string): readonly MessageBlock[] {
  return [{ type: "text", text }];
}

/** Whether a value read out of jsonb is a block this build understands. */
export function isMessageBlock(value: unknown): value is MessageBlock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return record["type"] === "text" && typeof record["text"] === "string";
}

/**
 * The text a stored message carries, or `undefined` when its blocks are not a
 * shape this build reads. A caller comparing a resubmitted nonce treats
 * `undefined` as "not the same text", so an unrecognized block kind can never
 * make two different sends look like a replay.
 */
export function messageText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return undefined;
  }

  const texts: string[] = [];

  for (const block of blocks) {
    if (!isMessageBlock(block)) {
      return undefined;
    }

    texts.push(block.text);
  }

  return texts.join("");
}

import { describe, expect, it } from "vitest";
import { isMessageBlock, messageText, textMessageBlocks } from "./message-blocks.ts";

/**
 * The block vocabulary is what lets a resubmitted nonce ask "is this the same
 * text?" without re-interpreting jsonb. The suite pins both directions: a
 * well-formed message yields its text, and anything this build does not
 * understand yields `undefined` so a comparison treats it as different text
 * rather than equal by accident.
 */

describe("message blocks", () => {
  it("builds one text block from a send's text", () => {
    expect(textMessageBlocks("summarise the inbox")).toEqual([
      { type: "text", text: "summarise the inbox" },
    ]);
  });

  it("reads the text back, including an empty text block", () => {
    expect(messageText(textMessageBlocks("hello"))).toBe("hello");
    expect(messageText([{ type: "text", text: "" }])).toBe("");
  });

  it("joins multiple text blocks in order", () => {
    expect(
      messageText([
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ]),
    ).toBe("one two");
  });

  it("returns undefined for anything that is not a well-formed block list", () => {
    const rejected: readonly unknown[] = [
      undefined,
      null,
      "hello",
      {},
      [],
      [{ type: "text" }],
      [{ type: "text", text: 7 }],
      [{ type: "image", url: "https://example.test/a.png" }],
      [{ type: "text", text: "ok" }, "not a block"],
      [["text", "hello"]],
    ];

    for (const blocks of rejected) {
      expect(messageText(blocks), JSON.stringify(blocks)).toBeUndefined();
    }
  });

  it("recognizes exactly the text block it understands", () => {
    expect(isMessageBlock({ type: "text", text: "" })).toBe(true);
    expect(isMessageBlock({ type: "text", text: "hi" })).toBe(true);
    expect(isMessageBlock({ type: "text", text: "hi", extra: true })).toBe(true);
    expect(isMessageBlock({ type: "tool", callId: "call-1" })).toBe(false);
    expect(isMessageBlock(null)).toBe(false);
    expect(isMessageBlock([])).toBe(false);
  });
});

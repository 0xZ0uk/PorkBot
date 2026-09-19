import { describe, expect, it } from "vitest";
import {
  isFileMessageBlock,
  isMessageBlock,
  messageBlocksForSend,
  messageFiles,
  messagePromptWithAttachments,
  messageText,
  textMessageBlocks,
} from "./message-blocks.ts";
import type { FileMessageBlock } from "./message-blocks.ts";

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

const report: FileMessageBlock = {
  type: "file",
  attachmentId: "attachment-1",
  filename: "report.pdf",
  contentType: "application/pdf",
  sizeBytes: 2_048,
};

describe("file message blocks", () => {
  it("builds a send's blocks with the text first and each file after", () => {
    expect(messageBlocksForSend("read this", [report])).toEqual([
      { type: "text", text: "read this" },
      report,
    ]);
  });

  it("reads the file blocks back in order and leaves text out of them", () => {
    expect(messageFiles([{ type: "text", text: "hi" }, report])).toEqual([report]);
    expect(messageFiles([report, report])).toEqual([report, report]);
    expect(messageFiles([])).toEqual([]);
    expect(messageText([report])).toBe("");
    expect(messageText([{ type: "text", text: "hi" }, report])).toBe("hi");
  });

  it("recognizes exactly the file block it understands", () => {
    expect(isFileMessageBlock(report)).toBe(true);
    expect(isMessageBlock(report)).toBe(true);
    expect(isFileMessageBlock({ ...report, attachmentId: "" })).toBe(false);
    expect(isFileMessageBlock({ ...report, filename: "" })).toBe(false);
    expect(isFileMessageBlock({ ...report, contentType: "" })).toBe(false);
    expect(isFileMessageBlock({ ...report, sizeBytes: -1 })).toBe(false);
    expect(isFileMessageBlock({ ...report, sizeBytes: 1.5 })).toBe(false);
    expect(isFileMessageBlock({ ...report, sizeBytes: "12" })).toBe(false);
  });

  it("returns undefined for a list with an unknown block kind", () => {
    expect(messageFiles([{ type: "image", url: "https://example.test/a.png" }])).toBeUndefined();
    expect(
      messageText([
        { type: "text", text: "ok" },
        { type: "tool", callId: "call-1" },
      ]),
    ).toBeUndefined();
  });

  it("names each attachment's home-relative path in the run's prompt", () => {
    expect(messagePromptWithAttachments("please summarise", [report])).toBe(
      "please summarise\n\n" +
        "Files attached to this message are in the computer's home directory:\n" +
        "- attachments/attachment-1/report.pdf (application/pdf, 2048 bytes)",
    );
  });

  it("leaves the prompt alone when there are no attachments", () => {
    expect(messagePromptWithAttachments("hello", textMessageBlocks("hello"))).toBe("hello");
  });
});

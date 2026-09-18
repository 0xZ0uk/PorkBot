import { CursorRejectedError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import { createCursorCodec } from "./cursors.ts";
import type { CursorBinding } from "./cursors.ts";

/**
 * Cursor integrity, tested against a forged value rather than only a valid
 * one: a cursor signed for one actor, space or thread must not verify for
 * another, a tampered payload must not verify at all, and neither must
 * anything that is not a cursor.
 */

const binding: CursorBinding = {
  spaceId: "space-1",
  threadId: "thread-1",
  userId: "user-1",
};

describe("the cursor codec", () => {
  it("round-trips a position for its binding", () => {
    const codec = createCursorCodec();

    const cursor = codec.sign({ ...binding, seq: 42 });

    expect(codec.verify(cursor, binding)).toBe(42);
  });

  it("refuses a cursor signed for another actor, space or thread", () => {
    const codec = createCursorCodec();

    const cursor = codec.sign({ ...binding, seq: 7 });

    expect(() => codec.verify(cursor, { ...binding, userId: "user-2" })).toThrow(
      CursorRejectedError,
    );
    expect(() => codec.verify(cursor, { ...binding, spaceId: "space-2" })).toThrow(
      CursorRejectedError,
    );
    expect(() => codec.verify(cursor, { ...binding, threadId: "thread-2" })).toThrow(
      CursorRejectedError,
    );

    try {
      codec.verify(cursor, { ...binding, threadId: "thread-2" });
    } catch (error) {
      expect(error).toMatchObject({ _tag: "CursorRejectedError", reason: "binding" });
    }
  });

  it("refuses a payload tampered after signing", () => {
    const codec = createCursorCodec();
    const cursor = codec.sign({ ...binding, seq: 7 });
    const [payload = "", signature = ""] = cursor.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, s: "space-1", t: "thread-1", u: "user-1", q: 999 }),
      "utf8",
    ).toString("base64url");

    expect(() => codec.verify(`${forgedPayload}.${signature}`, binding)).toThrow(
      CursorRejectedError,
    );

    try {
      codec.verify(`${forgedPayload}.${signature}`, binding);
    } catch (error) {
      expect(error).toMatchObject({ reason: "forged" });
    }

    // The untouched payload with a flipped signature is forged too.
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(() => codec.verify(`${payload}.${flipped}`, binding)).toThrow(CursorRejectedError);
  });

  it("refuses a cursor signed with another process's key", () => {
    const minted = createCursorCodec("key-one").sign({ ...binding, seq: 3 });
    const verifier = createCursorCodec("key-two");

    expect(() => verifier.verify(minted, binding)).toThrow(CursorRejectedError);
  });

  it("refuses values that are not cursors, however well formed", () => {
    const codec = createCursorCodec();

    for (const value of ["", "not-a-cursor", "one.two.three", ".", "payload.", ".signature"]) {
      expect(() => codec.verify(value, binding), JSON.stringify(value)).toThrow(
        CursorRejectedError,
      );
    }
  });

  it("refuses an oversized value without hashing it", () => {
    const codec = createCursorCodec();

    expect(() => codec.verify("a".repeat(4_096), binding)).toThrow(CursorRejectedError);
  });

  it("refuses an empty signing key", () => {
    expect(() => createCursorCodec("")).toThrow(/must not be empty/);
    expect(() => createCursorCodec(new Uint8Array(0))).toThrow(/must not be empty/);
  });
});

import { describe, expect, it } from "vitest";
import {
  avatarContentTypes,
  botAvatarUploadSchema,
  botListScopeSchema,
  botSchema,
  maxAvatarBase64Length,
  maxAvatarBytes,
} from "./index.ts";

/**
 * The bot contract's bounds: what an avatar upload may carry, and which states
 * a bot body may name. These are the limits the API enforces at the wire and
 * the service enforces again at the seam, so they are pinned here rather than
 * referenced by two call sites that could drift.
 */

describe("the bot schema", () => {
  it("names the nullable links a bot may have none of", () => {
    const parsed = botSchema.parse({
      id: "bot-1",
      name: "Ada",
      title: "",
      description: "",
      instructions: "",
      color: "#4f46e5",
      pinned: false,
      position: 0,
      sectionId: null,
      avatarKey: null,
      computerId: null,
      computerProvider: null,
      modelConnectionId: null,
      model: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(parsed.sectionId).toBeNull();
    expect(parsed.avatarKey).toBeNull();
    expect(parsed.computerId).toBeNull();
    expect(parsed.modelConnectionId).toBeNull();
    expect(parsed.model).toBeNull();
  });
});

describe("the list scopes", () => {
  it("offers active, archived and all, and nothing else", () => {
    expect(botListScopeSchema.options).toEqual(["active", "archived", "all"]);
  });
});

describe("the avatar upload schema", () => {
  it("bounds the base64 to what the byte limit encodes", () => {
    expect(maxAvatarBase64Length).toBe(Math.ceil(maxAvatarBytes / 3) * 4);
  });

  it("accepts a supported image within the bound", () => {
    const parsed = botAvatarUploadSchema.parse({
      id: "bot-1",
      contentType: "image/png",
      data: Buffer.from("tiny").toString("base64"),
    });

    expect(parsed.contentType).toBe("image/png");
  });

  it("refuses a content type a browser would not render as an image", () => {
    expect(
      botAvatarUploadSchema.safeParse({
        id: "bot-1",
        contentType: "image/svg+xml",
        data: "aGk=",
      }).success,
    ).toBe(false);

    expect(avatarContentTypes).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif"]);
  });

  it("refuses a payload that is not base64 or over the bound", () => {
    expect(
      botAvatarUploadSchema.safeParse({
        id: "bot-1",
        contentType: "image/png",
        data: "not base64!",
      }).success,
    ).toBe(false);

    expect(
      botAvatarUploadSchema.safeParse({
        id: "bot-1",
        contentType: "image/png",
        data: "A".repeat(maxAvatarBase64Length + 4),
      }).success,
    ).toBe(false);
  });
});

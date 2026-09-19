import { PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  modelBaseUrlSchema,
  modelFailureKindSchema,
  modelProbeSchema,
} from "./model-connections.ts";

/**
 * The wire shapes only the transport owns: the probe's failure enum mirrors
 * the provider vocabulary `@porkbot/adapter-kit` owns, and the base-URL schema
 * accepts the URLs the provider can join a path to and refuses the rest. The
 * pin matters because lifecycle code branches on the vocabulary while a client
 * renders this enum; a sixth kind added in adapter-kit must fail here rather
 * than reach a UI that has never heard of it.
 */

describe("the model probe schema", () => {
  it("mirrors the provider failure vocabulary exactly", () => {
    expect(modelFailureKindSchema.options).toEqual([...PROVIDER_FAILURE_KINDS]);
  });

  it("accepts a refusal-shaped probe result", () => {
    expect(
      modelProbeSchema.parse({
        reachable: false,
        models: [],
        streaming: false,
        failure: "rate_limited",
      }),
    ).toEqual({ reachable: false, models: [], streaming: false, failure: "rate_limited" });
  });
});

describe("the model base URL schema", () => {
  it("accepts an absolute http(s) URL without credentials, query or fragment", () => {
    expect(modelBaseUrlSchema.safeParse("https://model.example.invalid/v1").success).toBe(true);
    expect(modelBaseUrlSchema.safeParse("http://127.0.0.1:11434/v1").success).toBe(true);
  });

  it("refuses a URL the provider cannot join a path to", () => {
    for (const value of [
      "model.example.invalid/v1",
      "ftp://model.example.invalid/v1",
      "https://user:secret@model.example.invalid/v1",
      "https://model.example.invalid/v1?key=secret",
      "https://model.example.invalid/v1#fragment",
      "",
    ]) {
      expect(modelBaseUrlSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

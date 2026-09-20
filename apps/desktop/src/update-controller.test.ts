import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createUpdateController } from "./update-controller.ts";
import { signingPayload } from "./updates.ts";
import type { UpdateManifest } from "./updates.ts";

/**
 * The controller, driven by a scripted feed and artifact: what these tests
 * prove is the ordering — nothing is written before the signature and the
 * digest verify — and the refusals an unsigned, mis-signed or tampered release
 * meets.
 */

const artifactBytes = Buffer.from("PorkBot 1.4.0 artifact bytes");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function manifestWith(overrides: Partial<UpdateManifest> = {}): UpdateManifest {
  const unsigned = {
    version: "1.4.0",
    url: "https://updates.example.com/PorkBot-1.4.0.AppImage",
    sha512: createHash("sha512").update(artifactBytes).digest("base64"),
    ...overrides,
  };

  return {
    ...unsigned,
    signature:
      overrides.signature ??
      signPayload(null, signingPayload(unsigned), privateKey).toString("base64"),
  };
}

interface Scripted {
  readonly requests: string[];
  readonly fetch: typeof fetch;
}

function scriptedFetch(options: {
  readonly manifest?: unknown;
  readonly status?: number;
  readonly artifact?: Buffer;
}): Scripted {
  const requests: string[] = [];

  const perform = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);

    if (url.endsWith("update.json")) {
      if (options.status !== undefined && options.status !== 200) {
        return new Response("nope", { status: options.status });
      }

      return new Response(JSON.stringify(options.manifest ?? manifestWith()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(options.artifact ?? artifactBytes, { status: 200 });
  };

  return { requests, fetch: perform as typeof fetch };
}

async function controllerWith(options: {
  readonly feedUrl?: string | undefined;
  readonly publicKey?: string | undefined;
  readonly fetch: typeof fetch;
  readonly currentVersion?: string;
}): Promise<{
  controller: ReturnType<typeof createUpdateController>;
  downloadDirectory: string;
}> {
  const downloadDirectory = await mkdtemp(path.join(tmpdir(), "porkbot-desktop-updates-"));

  return {
    downloadDirectory,
    controller: createUpdateController({
      feedUrl: options.feedUrl,
      publicKey: options.publicKey,
      currentVersion: options.currentVersion ?? "1.3.0",
      downloadDirectory,
      fetch: options.fetch,
    }),
  };
}

describe("the update check", () => {
  it("checks nothing when the build has no signed feed", async () => {
    const scripted = scriptedFetch({});
    const { controller } = await controllerWith({ fetch: scripted.fetch });

    expect(await controller.check()).toEqual({ status: "not_configured" });
    expect(scripted.requests).toEqual([]);
  });

  it("refuses a feed that is not HTTPS without dialling it", async () => {
    const scripted = scriptedFetch({});
    const { controller } = await controllerWith({
      feedUrl: "http://updates.example.com",
      publicKey: publicKeyBase64,
      fetch: scripted.fetch,
    });

    expect(await controller.check()).toMatchObject({ status: "refused", refusal: "insecure_url" });
    expect(scripted.requests).toEqual([]);
  });

  it("refuses an unsigned manifest and writes no artifact", async () => {
    const unsigned: Record<string, unknown> = { ...manifestWith() };

    delete unsigned["signature"];

    const scripted = scriptedFetch({ manifest: unsigned });
    const { controller, downloadDirectory } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      fetch: scripted.fetch,
    });

    expect(await controller.check()).toMatchObject({ status: "refused", refusal: "unsigned" });
    expect(await readdir(downloadDirectory)).toEqual([]);
    expect(scripted.requests).toEqual(["https://updates.example.com/porkbot/update.json"]);
  });

  it("refuses a manifest signed by another key", async () => {
    const { privateKey: otherKey } = generateKeyPairSync("ed25519");
    const unsigned = manifestWith();
    const foreign = {
      ...unsigned,
      signature: signPayload(null, signingPayload(unsigned), otherKey).toString("base64"),
    };
    const scripted = scriptedFetch({ manifest: foreign });
    const { controller, downloadDirectory } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      fetch: scripted.fetch,
    });

    expect(await controller.check()).toMatchObject({
      status: "refused",
      refusal: "bad_signature",
    });
    expect(await readdir(downloadDirectory)).toEqual([]);
  });

  it("reports an already-current version without downloading", async () => {
    const scripted = scriptedFetch({ manifest: manifestWith() });
    const { controller } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      currentVersion: "1.4.0",
      fetch: scripted.fetch,
    });

    expect(await controller.check()).toEqual({ status: "up_to_date", version: "1.4.0" });
    expect(scripted.requests).toEqual(["https://updates.example.com/porkbot/update.json"]);
  });

  it("refuses a tampered artifact and leaves nothing staged", async () => {
    const scripted = scriptedFetch({
      manifest: manifestWith(),
      artifact: Buffer.from("the artifact bytes, modified on the wire"),
    });
    const { controller, downloadDirectory } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      fetch: scripted.fetch,
    });

    expect(await controller.check()).toMatchObject({
      status: "refused",
      refusal: "hash_mismatch",
    });
    expect(await readdir(downloadDirectory)).toEqual([]);
  });

  it("refuses an unreachable feed and an unreachable artifact", async () => {
    const throwing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const { controller } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      fetch: throwing,
    });

    expect(await controller.check()).toMatchObject({ status: "refused", refusal: "unreachable" });

    const statusFailure = scriptedFetch({ status: 503, manifest: manifestWith() });
    const second = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot",
      publicKey: publicKeyBase64,
      fetch: statusFailure.fetch,
    });

    expect(await second.controller.check()).toMatchObject({
      status: "refused",
      refusal: "unreachable",
    });
  });

  it("stages the verified artifact and reports it ready", async () => {
    const scripted = scriptedFetch({ manifest: manifestWith() });
    const { controller, downloadDirectory } = await controllerWith({
      feedUrl: "https://updates.example.com/porkbot/",
      publicKey: publicKeyBase64,
      fetch: scripted.fetch,
    });

    const result = await controller.check();

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.version).toBe("1.4.0");
      expect(path.dirname(result.artifactPath)).toBe(downloadDirectory);
      expect(await readFile(result.artifactPath)).toEqual(artifactBytes);
    }

    expect(scripted.requests).toEqual([
      "https://updates.example.com/porkbot/update.json",
      "https://updates.example.com/PorkBot-1.4.0.AppImage",
    ]);
  });
});

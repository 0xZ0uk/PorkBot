/**
 * The update check, end to end (slice 11.6).
 *
 * The controller is the only place an update is fetched or written. It reads
 * the feed, parses and verifies the manifest through `updates.ts`, refuses a
 * version that is not newer, downloads the artifact, verifies its bytes against
 * the signed digest, and only then stages it on disk and reports it ready. An
 * unsigned, mis-signed, tampered, non-HTTPS or unreachable update therefore
 * never reaches the file system, which is the state the tests assert.
 *
 * The feed and the pinned public key are deployment configuration, not
 * secrets: a self-hosted build with no feed configured reports
 * `not_configured` and checks nothing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isNewerVersion,
  parseUpdateManifest,
  refusalMessage,
  verifyUpdateArtifact,
  verifyUpdateManifest,
} from "./updates.ts";
import type { UpdateRefusal } from "./updates.ts";

export type UpdateCheckResult =
  | { readonly status: "not_configured" }
  | { readonly status: "up_to_date"; readonly version: string }
  | { readonly status: "refused"; readonly refusal: UpdateRefusal; readonly message: string }
  | { readonly status: "ready"; readonly version: string; readonly artifactPath: string };

export interface UpdateControllerOptions {
  /** Base URL the release publishes `update.json` under; unset disables checks. */
  readonly feedUrl: string | undefined;
  /** The Ed25519 public key, base64 SPKI DER or PEM; unset disables checks. */
  readonly publicKey: string | undefined;
  /** The running app version, compared against the manifest's. */
  readonly currentVersion: string;
  /** Directory the verified artifact is staged in. */
  readonly downloadDirectory: string;
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof fetch;
  /** One-line notes for the app log; never a response body. */
  readonly log?: (message: string) => void;
}

export interface UpdateController {
  check(): Promise<UpdateCheckResult>;
}

function refused(refusal: UpdateRefusal): UpdateCheckResult {
  return { status: "refused", refusal, message: refusalMessage(refusal) };
}

/** A filename safe to stage: the URL's basename, or a versioned default. */
function artifactFileName(url: string, version: string): string {
  let name: string;

  try {
    name = path.basename(new URL(url).pathname);
  } catch {
    name = "";
  }

  const safe = name.replace(/[^A-Za-z0-9._-]/g, "");

  return safe.length > 0 ? safe : `PorkBot-${version}`;
}

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const perform = options.fetch ?? globalThis.fetch;

  async function check(): Promise<UpdateCheckResult> {
    const feedUrl = options.feedUrl?.trim();
    const publicKey = options.publicKey?.trim();

    if (feedUrl === undefined || feedUrl === "" || publicKey === undefined || publicKey === "") {
      return { status: "not_configured" };
    }

    let manifestUrl: string;

    try {
      const feed = new URL(feedUrl);

      if (feed.protocol !== "https:") {
        return refused("insecure_url");
      }

      // The feed is a directory: `…/porkbot` and `…/porkbot/` are the same
      // place, and the manifest is always `update.json` under it.
      const base = feed.href.endsWith("/") ? feed.href : `${feed.href}/`;

      manifestUrl = new URL("update.json", base).href;
    } catch {
      return refused("malformed");
    }

    let response: Response;

    try {
      response = await perform(manifestUrl, { cache: "no-store", redirect: "error" });
    } catch {
      return refused("unreachable");
    }

    if (!response.ok) {
      return refused("unreachable");
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      return refused("malformed");
    }

    const parsed = parseUpdateManifest(body);

    if (!parsed.ok) {
      return { status: "refused", refusal: parsed.refusal, message: parsed.message };
    }

    const verified = verifyUpdateManifest(parsed.manifest, publicKey);

    if (!verified.ok) {
      return { status: "refused", refusal: verified.refusal, message: verified.message };
    }

    if (!isNewerVersion(parsed.manifest.version, options.currentVersion)) {
      return { status: "up_to_date", version: options.currentVersion };
    }

    let artifact: Response;

    try {
      artifact = await perform(parsed.manifest.url, { cache: "no-store", redirect: "error" });
    } catch {
      return refused("unreachable");
    }

    if (!artifact.ok) {
      return refused("unreachable");
    }

    const bytes = new Uint8Array(await artifact.arrayBuffer());
    const hashed = verifyUpdateArtifact(bytes, parsed.manifest);

    if (!hashed.ok) {
      return { status: "refused", refusal: hashed.refusal, message: hashed.message };
    }

    const artifactPath = path.join(
      options.downloadDirectory,
      artifactFileName(parsed.manifest.url, parsed.manifest.version),
    );

    await mkdir(options.downloadDirectory, { recursive: true });
    await writeFile(artifactPath, bytes);
    options.log?.(`staged verified update ${parsed.manifest.version}`);

    return { status: "ready", version: parsed.manifest.version, artifactPath };
  }

  return { check };
}

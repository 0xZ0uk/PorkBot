import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRunEvent } from "@porkbot/core";
import type { ThreadSnapshot } from "@porkbot/core";
import { reducePiCorpus, replayPiCorpus } from "./pi-corpus/replay.ts";
import { abortedEvents } from "./pi-corpus/aborted.events.ts";
import { agentErrorEvents } from "./pi-corpus/agent-error.events.ts";
import { textTurnEvents } from "./pi-corpus/text-turn.events.ts";
import { toolFailureEvents } from "./pi-corpus/tool-failure.events.ts";
import { toolTurnEvents } from "./pi-corpus/tool-turn.events.ts";

/**
 * The golden corpus (slice 5.3, testing decisions): recorded real-session Pi
 * events, replayed through the shipped adapter and reduced to the snapshot a
 * client renders.
 *
 * The corpus is recorded from the pinned Pi version by
 * `scripts/record-pi-fixtures.mjs`. `manifest.json` names that version, and
 * this suite refuses the recording when the pin in `package.json` or in
 * `dependencies.json` has moved without the corpus being re-recorded — so a pin
 * change cannot merge on a stale replay.
 */

interface CorpusSession {
  readonly name: string;
  readonly description: string;
  readonly events: string;
  readonly snapshot: string;
}

interface CorpusManifest {
  readonly piVersion: string;
  readonly sessions: readonly CorpusSession[];
}

interface PinnedPackage {
  readonly name: string;
  readonly version: string;
}

interface DependencyRegister {
  readonly packages: readonly PinnedPackage[];
}

const PI_PACKAGE = "@earendil-works/pi-agent-core";

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8")) as T;
}

const manifest = readJson<CorpusManifest>("./pi-corpus/manifest.json");
const adaptersPackage = readJson<{ dependencies: Record<string, string> }>("../package.json");
const register = readJson<DependencyRegister>("../../../dependencies.json");

const fixtures: Readonly<Record<string, readonly unknown[]>> = {
  "text-turn": textTurnEvents,
  "tool-turn": toolTurnEvents,
  "tool-failure": toolFailureEvents,
  "agent-error": agentErrorEvents,
  aborted: abortedEvents,
};

function committedSnapshot(session: CorpusSession): ThreadSnapshot {
  return readJson<ThreadSnapshot>(`./pi-corpus/${session.name}.snapshot.json`);
}

describe("the Pi golden corpus", () => {
  it("matches the pinned Pi version on every declaration", () => {
    expect(adaptersPackage.dependencies[PI_PACKAGE]).toBe(manifest.piVersion);

    const pinned = register.packages.find((entry) => entry.name === PI_PACKAGE);
    expect(pinned, "the register must pin Pi").toBeDefined();
    expect(pinned?.version).toBe(manifest.piVersion);
  });

  it("records a fixture and a committed snapshot for every manifest session", () => {
    for (const session of manifest.sessions) {
      expect(fixtures[session.name], `missing fixture for ${session.name}`).toBeDefined();
      expect(committedSnapshot(session), `missing snapshot for ${session.name}`).toBeDefined();
    }

    expect(Object.keys(fixtures).sort()).toEqual(manifest.sessions.map((s) => s.name).sort());
  });

  it.each(manifest.sessions.map((session) => [session.name, session] as const))(
    "replays the %s session to its committed snapshot",
    async (_name, session) => {
      const events = fixtures[session.name];
      expect(events).toBeDefined();

      const replayed = await replayPiCorpus(events ?? []);
      expect(replayed.every((event) => parseRunEvent(event).ok)).toBe(true);

      expect(reducePiCorpus(replayed)).toEqual(committedSnapshot(session));
    },
  );

  it("replays the same recorded session to the same snapshot every time", async () => {
    const session = manifest.sessions.find((entry) => entry.name === "tool-turn");
    expect(session).toBeDefined();

    const events = fixtures["tool-turn"] ?? [];
    const first = reducePiCorpus(await replayPiCorpus(events));
    const second = reducePiCorpus(await replayPiCorpus(events));

    expect(second).toEqual(first);
  });
});

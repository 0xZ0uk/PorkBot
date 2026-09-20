import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  emptySettings,
  parseSettings,
  readSettings,
  settingsFilePath,
  writeSettings,
} from "./settings.ts";

async function scratchDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "porkbot-desktop-settings-"));
}

describe("desktop settings", () => {
  it("round-trips the server address", async () => {
    const directory = await scratchDirectory();
    const file = settingsFilePath(directory);

    expect(await readSettings(file)).toEqual(emptySettings);

    await writeSettings(file, { serverOrigin: "https://porkbot.example.com" });

    expect(await readSettings(file)).toEqual({ serverOrigin: "https://porkbot.example.com" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      serverOrigin: "https://porkbot.example.com",
    });
  });

  it("reads a corrupt or hand-edited file as unconfigured", async () => {
    expect(parseSettings("{not json")).toEqual(emptySettings);
    expect(parseSettings("null")).toEqual(emptySettings);
    expect(parseSettings(JSON.stringify({ serverOrigin: 7 }))).toEqual(emptySettings);
    expect(parseSettings(JSON.stringify({ serverOrigin: "http://evil.example.com" }))).toEqual(
      emptySettings,
    );
    expect(
      parseSettings(JSON.stringify({ serverOrigin: "https://porkbot.example.com/rpc" })),
    ).toEqual(emptySettings);
  });

  it("normalizes what it stores", () => {
    expect(parseSettings(JSON.stringify({ serverOrigin: "porkbot.example.com/" }))).toEqual({
      serverOrigin: "https://porkbot.example.com",
    });
  });

  it("reports an unreadable file rather than throwing", async () => {
    const directory = await scratchDirectory();

    await writeFile(path.join(directory, "desktop-settings.json"), "{half", "utf8");

    expect(await readSettings(settingsFilePath(directory))).toEqual(emptySettings);
  });
});

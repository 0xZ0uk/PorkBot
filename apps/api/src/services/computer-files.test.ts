import { InvalidComputerPathError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import {
  clampCommandOutput,
  computerCommandTimeoutMs,
  computerViewHome,
  directoryListingCommands,
  fileReadCommand,
  parseDirectoryListing,
  resolveViewPath,
} from "./computer-files.ts";

/**
 * The file view's command and parse rules (slice 11.4). The listing is the
 * machine's own `ls` output, so the parser is pinned against both shapes the
 * providers produce — the emulator's fixed columns and GNU coreutils' `total`
 * header — and the path rule is pinned to the home the model's file tools are
 * confined to, so the operator view and the tool view cannot disagree about
 * where a bot's files live.
 */

describe("resolving a view path", () => {
  it("treats an absent or empty path as the home itself", () => {
    expect(resolveViewPath(undefined)).toEqual({ path: computerViewHome, relative: "" });
    expect(resolveViewPath("")).toEqual({ path: computerViewHome, relative: "" });
  });

  it("resolves a home-relative path and the same path spelled absolutely", () => {
    expect(resolveViewPath("notes/todo.md")).toEqual({
      path: `${computerViewHome}/notes/todo.md`,
      relative: "notes/todo.md",
    });
    expect(resolveViewPath(`${computerViewHome}/notes`)).toEqual({
      path: `${computerViewHome}/notes`,
      relative: "notes",
    });
  });

  it("folds a traversal that stays inside the home", () => {
    expect(resolveViewPath("notes/../todo.md").relative).toBe("todo.md");
  });

  it("refuses a path that leaves the home", () => {
    expect(() => resolveViewPath("../etc/passwd")).toThrow(InvalidComputerPathError);
    expect(() => resolveViewPath("/etc/passwd")).toThrow(InvalidComputerPathError);
    expect(() => resolveViewPath(`/tmp`)).toThrow(InvalidComputerPathError);
  });
});

describe("the commands one view runs", () => {
  it("names one listing per line and one long listing, both with the path quoted", () => {
    expect(directoryListingCommands(`${computerViewHome}/my notes`)).toEqual({
      names: `ls -1 -- '${computerViewHome}/my notes'`,
      details: `ls -l -- '${computerViewHome}/my notes'`,
    });
  });

  it("quotes a quote so a path cannot terminate the argument", () => {
    expect(fileReadCommand(`${computerViewHome}/it's.md`)).toBe(
      `cat -- '${computerViewHome}/it'\\''s.md'`,
    );
  });

  it("gives one command a minute, the run tools' own default", () => {
    expect(computerCommandTimeoutMs).toBe(60_000);
  });
});

describe("parsing a directory listing", () => {
  it("reads the emulator's fixed columns", () => {
    const names = "notes.md\nprojects\n";
    const details = [
      "-rw-r--r-- 1 agent agent 12 1970-01-01 00:00 notes.md",
      "drwxr-xr-x 1 agent agent 0 1970-01-01 00:00 projects",
      "",
    ].join("\n");

    expect(parseDirectoryListing(names, details)).toEqual([
      { name: "notes.md", kind: "file", sizeBytes: 12 },
      { name: "projects", kind: "directory", sizeBytes: 0 },
    ]);
  });

  it("drops GNU's total header and still pairs every name", () => {
    const names = "notes.md\nprojects\n";
    const details = [
      "total 4",
      "-rw-r--r-- 1 agent agent 12 Sep 20 12:00 notes.md",
      "drwxr-xr-x 2 agent agent 4096 Sep 20 12:00 projects",
      "",
    ].join("\n");

    expect(parseDirectoryListing(names, details)).toEqual([
      { name: "notes.md", kind: "file", sizeBytes: 12 },
      { name: "projects", kind: "directory", sizeBytes: 4096 },
    ]);
  });

  it("keeps a file name with spaces whole", () => {
    const entries = parseDirectoryListing(
      "my notes.md\n",
      "-rw-r--r-- 1 agent agent 12 Sep 20 12:00 my notes.md\n",
    );

    expect(entries).toEqual([{ name: "my notes.md", kind: "file", sizeBytes: 12 }]);
  });

  it("reports a name with no detail line as a file of unknown size rather than dropping it", () => {
    expect(parseDirectoryListing("appeared.md\n", "")).toEqual([
      { name: "appeared.md", kind: "file", sizeBytes: 0 },
    ]);
  });

  it("answers an empty directory with no entries", () => {
    expect(parseDirectoryListing("", "total 0\n")).toEqual([]);
  });
});

describe("bounding a command's output", () => {
  it("passes a short value through untouched", () => {
    expect(clampCommandOutput("hello", 16)).toEqual({ text: "hello", truncated: false });
  });

  it("cuts at the byte bound and says so", () => {
    const clamped = clampCommandOutput("abcdef", 3);

    expect(clamped).toEqual({ text: "abc", truncated: true });
  });

  it("never leaves a half-written multi-byte character at the cut", () => {
    // "é" is two bytes; cutting between them must not produce a replacement
    // character the machine never wrote.
    const clamped = clampCommandOutput("aé", 2);

    expect(clamped.truncated).toBe(true);
    expect(clamped.text).toBe("a");
  });
});

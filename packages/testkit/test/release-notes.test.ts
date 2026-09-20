import { describe, expect, it } from "vitest";
import { releaseNotesMarkdown } from "../src/release/notes.ts";

const log = [
  "a1b2c3d\tfeat: a connect-only Electron shell with hardening",
  "b2c3d4e\tfix: keep the tray tooltip from counting settled runs",
  "c3d4e5f\tdocs: describe the release process",
  "d4e5f6a\ttest: assert the packaged app reaches a server",
  "e5f6a7b\tci: package the desktop app in its own tier",
  "f6a7b8c\tchore: tidy the staging directory",
  "a7b8c9d\tmake the smoke test print its own diagnostics",
].join("\n");

describe("release notes", () => {
  it("groups commits by conventional type and keeps their hashes", () => {
    const notes = releaseNotesMarkdown({ version: "0.2.0", ref: "HEAD", log });

    expect(notes).toContain("## PorkBot desktop v0.2.0");
    expect(notes).toContain("### Features");
    expect(notes).toContain("- A connect-only Electron shell with hardening (`a1b2c3d`)");
    expect(notes).toContain("### Fixes");
    expect(notes).toContain("### Tests");
    expect(notes).toContain("### Build and CI");
    expect(notes).toContain("### Other changes");
    expect(notes).toContain("- Make the smoke test print its own diagnostics (`a7b8c9d`)");
  });

  it("omits a section no commit belongs to", () => {
    const notes = releaseNotesMarkdown({
      version: "0.2.0",
      ref: "HEAD",
      log: "a1b2c3d\tfeat: one thing",
    });

    expect(notes).not.toContain("### Fixes");
    expect(notes).not.toContain("### Performance");
  });

  it("says so when the range is empty rather than printing a bare heading", () => {
    const notes = releaseNotesMarkdown({ version: "0.2.0", ref: "HEAD", log: "" });

    expect(notes).toContain("No commits since the previous release.");
  });
});

import { describe, expect, it } from "vitest";
import {
  attachmentFileName,
  attachmentWorkspacePath,
  COMPUTER_HOME_DIRECTORY,
  confineToHome,
  contentTypeForFileName,
  MAX_ATTACHMENT_FILE_NAME_LENGTH,
} from "./files.ts";

/**
 * The file vocabulary's two rules: a path either stays inside the home or is
 * refused before a command can name it, and an untrusted file name becomes a
 * bounded name without directories.
 */

const home = COMPUTER_HOME_DIRECTORY;

function resolved(input: string): string {
  const outcome = confineToHome(home, input);
  expect(outcome.ok).toBe(true);
  return outcome.ok ? outcome.value.path : "";
}

function refused(input: string): string {
  const outcome = confineToHome(home, input);
  expect(outcome.ok).toBe(false);
  return outcome.ok ? "" : outcome.reason;
}

describe("confineToHome", () => {
  it("resolves a relative path against the home", () => {
    expect(resolved("notes/todo.md")).toBe(`${home}/notes/todo.md`);
  });

  it("resolves an absolute path already inside the home", () => {
    expect(resolved(`${home}/notes/todo.md`)).toBe(`${home}/notes/todo.md`);
    expect(resolved(`${home}`)).toBe(home);
  });

  it("normalizes dot segments that stay inside the home", () => {
    expect(resolved("notes/../todo.md")).toBe(`${home}/todo.md`);
    expect(resolved("./notes/./todo.md")).toBe(`${home}/notes/todo.md`);
    expect(resolved(".")).toBe(home);
  });

  it("reports a relative path that climbs out as outside the home", () => {
    expect(refused("../etc/passwd")).toBe("outside_home");
    expect(refused("notes/../../etc/passwd")).toBe("outside_home");
    expect(refused("..")).toBe("outside_home");
  });

  it("reports an absolute path outside the home as outside the home", () => {
    expect(refused("/etc/passwd")).toBe("outside_home");
    expect(refused("/home")).toBe("outside_home");
    expect(refused("/")).toBe("outside_home");
  });

  it("reports a NUL byte or an empty path as invalid", () => {
    expect(refused("notes/\u0000/todo.md")).toBe("invalid_path");
    expect(refused("")).toBe("invalid_path");
  });

  it("returns the home-relative form beside the absolute one", () => {
    const outcome = confineToHome(home, "notes/todo.md");

    expect(outcome.ok && outcome.value.relative).toBe("notes/todo.md");
  });

  it("refuses to confine against a home that is the root or relative", () => {
    expect(() => confineToHome("/", "notes")).toThrow(RangeError);
    expect(() => confineToHome("home/agent", "notes")).toThrow(RangeError);
  });
});

describe("attachmentFileName", () => {
  it("drops every directory component", () => {
    expect(attachmentFileName("/etc/passwd")).toBe("passwd");
    expect(attachmentFileName("..\\..\\secrets.txt")).toBe("secrets.txt");
    expect(attachmentFileName("docs/report.pdf")).toBe("report.pdf");
  });

  it("removes control characters and falls back for an empty result", () => {
    expect(attachmentFileName("re\u0000port.pdf")).toBe("report.pdf");
    expect(attachmentFileName("   ")).toBe("file");
    expect(attachmentFileName(".")).toBe("file");
    expect(attachmentFileName("..")).toBe("file");
    expect(attachmentFileName("/")).toBe("file");
  });

  it("bounds the kept name", () => {
    expect(attachmentFileName("x".repeat(500))).toHaveLength(MAX_ATTACHMENT_FILE_NAME_LENGTH);
  });
});

describe("attachmentWorkspacePath", () => {
  it("names one attachment under the home's attachments directory", () => {
    expect(attachmentWorkspacePath("attachment-1", "../report.pdf")).toBe(
      "attachments/attachment-1/report.pdf",
    );
  });
});

describe("contentTypeForFileName", () => {
  it("reads common extensions case-insensitively", () => {
    expect(contentTypeForFileName("REPORT.PDF")).toBe("application/pdf");
    expect(contentTypeForFileName("notes.md")).toBe("text/markdown");
    expect(contentTypeForFileName("log.txt")).toBe("text/plain");
    expect(contentTypeForFileName("rows.csv")).toBe("text/csv");
    expect(contentTypeForFileName("page.html")).toBe("text/html");
    expect(contentTypeForFileName("photo.jpeg")).toBe("image/jpeg");
    expect(contentTypeForFileName("photo.gif")).toBe("image/gif");
    expect(contentTypeForFileName("photo.webp")).toBe("image/webp");
    expect(contentTypeForFileName("icon.svg")).toBe("image/svg+xml");
    expect(contentTypeForFileName("bundle.json")).toBe("application/json");
    expect(contentTypeForFileName("archive.zip")).toBe("application/zip");
    expect(contentTypeForFileName("archive.gz")).toBe("application/gzip");
    expect(contentTypeForFileName("archive.tar")).toBe("application/x-tar");
    expect(contentTypeForFileName("clip.mp3")).toBe("audio/mpeg");
    expect(contentTypeForFileName("clip.wav")).toBe("audio/wav");
    expect(contentTypeForFileName("clip.mp4")).toBe("video/mp4");
    expect(contentTypeForFileName("clip.webm")).toBe("video/webm");
  });

  it("answers opaque bytes for an unknown or absent extension", () => {
    expect(contentTypeForFileName("archive.bin")).toBe("application/octet-stream");
    expect(contentTypeForFileName("LICENSE")).toBe("application/octet-stream");
    expect(contentTypeForFileName(".env")).toBe("application/octet-stream");
  });
});

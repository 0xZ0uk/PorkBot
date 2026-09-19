/**
 * The file vocabulary (slice 7.6, PRD stories 32 and 33).
 *
 * A bot's computer has one home directory, and everything the platform hands a
 * run — an operator's attachment, a file the agent wrote — is named relative to
 * it. This module owns the two decisions that must be made the same way in
 * every process that touches those bytes:
 *
 *   - **Where a path points, or that it does not.** `confineToHome` resolves a
 *     tool argument against the home lexically and refuses anything that leaves
 *     it, so the refusal happens in the tool layer before a command reaches the
 *     machine. A symlink inside the home is not resolved here: the machine's
 *     isolation owns that boundary, and the shell tool already crosses it.
 *   - **What an attachment is called.** A stored file name is untrusted input;
 *     `attachmentFileName` strips directories and control characters and
 *     bounds the length, and `attachmentWorkspacePath` gives the deterministic
 *     home-relative path the uploader, the worker and the model all name.
 *
 * The size and count caps live here too, so the upload route, the tool layer
 * and the message rule cannot disagree about "too big".
 */

/** The home directory a computer starts in, unless a provider configures its own. */
export const COMPUTER_HOME_DIRECTORY = "/home/agent";

/** The directory under the home where message attachments are materialized. */
export const MESSAGE_ATTACHMENTS_DIRECTORY = "attachments";

/** The largest single attachment, before it becomes a stored object. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The most attachments one message may carry. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/** The longest file name kept from untrusted input, in characters. */
export const MAX_ATTACHMENT_FILE_NAME_LENGTH = 200;

/** Why a path was refused. `outside_home` is the traversal case. */
export type HomePathRefusal = "invalid_path" | "outside_home";

/** A path resolved against a computer's home. */
export interface HomePath {
  /** The absolute path inside the home. */
  readonly path: string;
  /** The home-relative form, without a leading slash; `""` is the home itself. */
  readonly relative: string;
}

export type HomePathResolution =
  | { readonly ok: true; readonly value: HomePath }
  | { readonly ok: false; readonly reason: HomePathRefusal; readonly message: string };

/**
 * A path resolved against a computer's home, with the home escape kept rather
 * than refused. Only the danger policy reads an outside path: it is what turns
 * a `write_outside_home` claim into a gate instead of a flat refusal, and an
 * approved call then acts on this resolved path.
 */
export interface ResolvedComputerPath extends HomePath {
  /** Whether the path leaves the home; `relative` is empty when it does. */
  readonly outside: boolean;
}

/** A raw resolution: only a path that cannot name a file at all is refused. */
export type ComputerPathResolution =
  | { readonly ok: true; readonly value: ResolvedComputerPath }
  | { readonly ok: false; readonly reason: "invalid_path"; readonly message: string };

/** The sentence a refusal reaches the model as; the reason is the machine-readable half. */
export function homePathRefusalMessage(reason: HomePathRefusal, path: string): string {
  return reason === "outside_home"
    ? `"${path}" is outside this bot's home directory, so it cannot be read or written`
    : `"${path}" is not a usable filesystem path`;
}

/**
 * Resolves `input` against `home` exactly as {@link confineToHome} does, but
 * keeps a path that leaves the home instead of refusing it: `.` segments are
 * dropped, `..` segments are resolved, and a `..` that climbs past the root
 * clamps there (POSIX's own answer, so `/../etc` is `/etc`).
 *
 * This is the resolution the danger policy and an approved action share, so
 * the path a gate fired on and the path a command finally names cannot be two
 * different spellings. A `home` that is not an absolute path below the root is
 * a wiring defect, not a caller error, and throws.
 */
export function resolveComputerPath(home: string, input: string): ComputerPathResolution {
  if (!home.startsWith("/") || home === "/") {
    throw new RangeError(`home must be an absolute path below the root, received "${home}"`);
  }

  if (input === "" || input.includes("\u0000")) {
    return {
      ok: false,
      reason: "invalid_path",
      message: homePathRefusalMessage("invalid_path", input),
    };
  }

  const segments: string[] = [];
  const source = input.startsWith("/") ? input.slice(1) : `${home.slice(1)}/${input}`;

  for (const segment of source.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  const path = `/${segments.join("/")}`;
  const homeSegments = home.slice(1).split("/");
  const outside = path !== home && !path.startsWith(`${home}/`);

  return {
    ok: true,
    value: {
      path,
      relative: outside ? "" : segments.slice(homeSegments.length).join("/"),
      outside,
    },
  };
}

/**
 * Resolves `input` against `home` and refuses anything that leaves it.
 *
 * Both absolute and home-relative inputs are accepted; `.` segments are
 * dropped and `..` segments are resolved, so `notes/../todo.md` is inside the
 * home while `../etc/passwd` is refused.
 */
export function confineToHome(home: string, input: string): HomePathResolution {
  const resolution = resolveComputerPath(home, input);

  if (!resolution.ok) {
    return resolution;
  }

  if (resolution.value.outside) {
    return refusal("outside_home", input);
  }

  return { ok: true, value: { path: resolution.value.path, relative: resolution.value.relative } };
}

function refusal(reason: HomePathRefusal, path: string): HomePathResolution {
  return { ok: false, reason, message: homePathRefusalMessage(reason, path) };
}

/**
 * The file name kept from an untrusted name: directories are dropped, control
 * characters removed, and an empty or dot-only result becomes `file`. The
 * length is bounded so a message block cannot smuggle a path-sized name.
 */
export function attachmentFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";
  const cleaned = withoutControlCharacters(base).trim();

  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return "file";
  }

  return cleaned.slice(0, MAX_ATTACHMENT_FILE_NAME_LENGTH);
}

/**
 * Drops C0 and DEL characters one code point at a time. A regular expression
 * would be shorter and the linter forbids the control-character class, which
 * is the right rule: a name is text, and this is where text becomes text.
 */
function withoutControlCharacters(value: string): string {
  let result = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code >= 0x20 && code !== 0x7f) {
      result += character;
    }
  }

  return result;
}

/** The deterministic home-relative path one attachment is materialized at. */
export function attachmentWorkspacePath(attachmentId: string, fileName: string): string {
  return `${MESSAGE_ATTACHMENTS_DIRECTORY}/${attachmentId}/${attachmentFileName(fileName)}`;
}

/**
 * The content type guessed from a file name's extension, for artifacts the
 * platform derives from a path. A name with no known extension is opaque
 * bytes; the download still carries its stored name.
 */
export function contentTypeForFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot <= 0 ? "" : fileName.slice(dot + 1).toLowerCase();

  switch (extension) {
    case "txt":
    case "log":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "html":
    case "htm":
      return "text/html";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "zip":
      return "application/zip";
    case "gz":
      return "application/gzip";
    case "tar":
      return "application/x-tar";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    default:
      return "application/octet-stream";
  }
}

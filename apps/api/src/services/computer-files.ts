import { COMPUTER_HOME_DIRECTORY, confineToHome } from "@porkbot/core";
import { InvalidComputerPathError, quoteShellArgument } from "@porkbot/effect";

/**
 * The operator file view's command and parse rules (slice 11.4, PRD story 27).
 *
 * The file view reaches a computer through the same door the model's tools do:
 * `ComputerProvider.exec`, the provider-neutral seam the supervisor serves. It
 * has no second filesystem API, so the view works on the emulator and on a real
 * container without either growing a branch. Two listing commands are run — the
 * names one-per-line and the long form for kinds and sizes — and paired by
 * position: both `ls` invocations list the same directory in the same order, so
 * the pairing is stable between them. The long form's own fields are read
 * positionally (mode first, size fifth), which is the same shape under GNU
 * coreutils and the emulator, and no field beyond the size is trusted.
 *
 * The view is home-scoped. `confineToHome` from `@porkbot/core` resolves the
 * caller's path the same way the model's file tools resolve theirs, and a path
 * that leaves the home is the typed `InvalidComputerPathError` — the contract's
 * `BAD_REQUEST` — rather than a read the model would have had to ask an
 * operator to approve. The home is the view's whole namespace; the terminal is
 * the operator's way to the rest of the machine.
 *
 * The commands list what `file_list` lists: visible entries only. A hidden
 * file is still one `ls -a` away in the terminal, and the view does not invent
 * a second visibility rule.
 *
 * Two limits are inherited rather than invented. The confinement is lexical,
 * exactly as the model's file tools are: a symlink planted inside the home
 * that points outside it is followed by the machine's own shell, and the
 * sandbox is the boundary that owns it. And the listing is newline-delimited,
 * so a file name containing a newline arrives as two lines and is shown as two
 * entries; the shell seam offers no POSIX-safe one-name-per-entry form the
 * emulator and a real container both speak, and the terminal is where such a
 * name is reachable.
 */

/** The directory the file view starts in when the caller names none. */
export const computerViewHome = COMPUTER_HOME_DIRECTORY;

/**
 * How long one operator command may run before the supervisor's own timeout
 * answers `timed_out`. It matches the run tools' default: an operator watching
 * a terminal and a model waiting on a tool should wait the same amount.
 */
export const computerCommandTimeoutMs = 60_000;

export interface ResolvedViewPath {
  /** The absolute path inside the home the command names. */
  readonly path: string;
  /** The home-relative form the view reports; `""` is the home itself. */
  readonly relative: string;
}

/**
 * Resolves a caller's path against the bot's home, or refuses it. `undefined`
 * and the empty string mean the home, so the client's breadcrumb root is the
 * server's own answer rather than a client-side spelling.
 */
export function resolveViewPath(input: string | undefined): ResolvedViewPath {
  const resolution = confineToHome(
    computerViewHome,
    input === undefined || input === "" ? "." : input,
  );

  if (!resolution.ok) {
    throw new InvalidComputerPathError(input ?? ".");
  }

  return resolution.value;
}

/** The directory the view's single file read starts in. */
export function fileReadCommand(absolutePath: string): string {
  return `cat -- ${quoteShellArgument(absolutePath)}`;
}

/**
 * The two listings one directory view runs: `ls -1` for the names, one per
 * line and unambiguous, and `ls -l` for the leading mode and size fields.
 */
export function directoryListingCommands(absolutePath: string): {
  readonly names: string;
  readonly details: string;
} {
  return {
    names: `ls -1 -- ${quoteShellArgument(absolutePath)}`,
    details: `ls -l -- ${quoteShellArgument(absolutePath)}`,
  };
}

/**
 * One long-form line's mode and size, or a file of unknown size when the line
 * is not the shape the machine promised. The mode's first character is the
 * only classification read: `d` is a directory, everything else a file.
 */
function parseDetailLine(line: string): {
  readonly kind: "file" | "directory";
  readonly size: number;
} {
  const fields = line.trim().split(/\s+/);
  const mode = fields[0] ?? "";
  const size = Number(fields[4] ?? "");

  return {
    kind: mode.startsWith("d") ? "directory" : "file",
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
  };
}

/**
 * Whether the names output is a directory listing rather than an `ls` of the
 * path itself. A file target makes `ls` print the path it was given, which
 * contains a separator; an entry name never does, so one line with a slash is
 * the machine saying "this is not a directory" and the caller refuses it.
 */
export function isDirectoryListing(names: string): boolean {
  return !names.split("\n").some((line) => line.includes("/"));
}

/**
 * Pairs the names listing with the long listing. `ls -l` prefixes a directory
 * listing with a `total` line, which is dropped; the two lists are otherwise
 * one line per entry in the same order. A name with no matching detail line —
 * the directory changed between the two commands — is reported as a file of
 * unknown size rather than dropped, so a transient race never hides an entry.
 */
export function parseDirectoryListing(
  names: string,
  details: string,
): { readonly name: string; readonly kind: "file" | "directory"; readonly sizeBytes: number }[] {
  const nameLines = names.split("\n").filter((line) => line !== "");
  const detailLines = details
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("total "));

  return nameLines.map((name, index) => {
    const detail = detailLines[index];
    const parsed = detail === undefined ? undefined : parseDetailLine(detail);

    return {
      name,
      kind: parsed?.kind ?? "file",
      sizeBytes: parsed?.size ?? 0,
    };
  });
}

/**
 * A command's stream, bounded to what one view carries. The bytes beyond the
 * bound are dropped and the fact is reported, so a large file is never shown
 * as if it were whole.
 */
export function clampCommandOutput(
  value: string,
  maxBytes: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const bytes = new TextEncoder().encode(value);

  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }

  const text = new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, "");

  return { text, truncated: true };
}

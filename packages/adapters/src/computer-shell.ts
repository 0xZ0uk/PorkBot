import { readTar, writeTar } from "./computer-archive.ts";
import { ComputerProviderError } from "./computer-errors.ts";

/**
 * The deterministic shell behind the computer emulator (slice 6.9).
 *
 * A bot's computer is reached through one door — `ComputerProvider.exec` — so
 * the file and browser tools are shell commands, and the emulator has to give
 * them a shell. This is a bounded POSIX-shaped subset, not a general
 * interpreter: words, single and double quotes, `|`, `&&`, `||`, `;`, `>`,
 * `>>` and `2>` (stderr), and the command set below, including `sh -c` for a
 * caller that has to run a command as one grouped unit. There is no process
 * spawning, no environment, no command substitution, no input redirection, no
 * background jobs and no globbing, so the same command against the same
 * filesystem always produces the same bytes, exit code and stderr.
 *
 * Syntax the subset does not implement is refused with `exitCode` 2 and a
 * message on stderr rather than approximated: `$` and backticks because a real
 * shell would expand them, `<` and `&` because a real shell would act on them.
 * A command that would behave differently on a real machine fails here first.
 *
 * The world the commands run against is an interface, not the emulator's
 * internals: the emulator supplies its filesystem, its path resolution and its
 * scripted browser. That keeps the shell testable on its own and keeps the
 * emulator's state model in one place.
 *
 * Timeout handling is deliberately virtual: `sleep` models a command that
 * outruns the caller's budget and raises the seam's classified `timed_out`
 * immediately rather than blocking a test. No other command consumes time, so
 * a command either finishes in this call or the emulator says it could not.
 */

export class ShellIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellIoError";
  }
}

export class ShellSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellSyntaxError";
  }
}

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly bytes: number;
}

export type ShellBrowserCommand =
  | { readonly action: "open"; readonly url: string }
  | { readonly action: "click"; readonly selector: string }
  | { readonly action: "type"; readonly selector: string; readonly text: string }
  | { readonly action: "read" };

export interface BrowserPageOutcome {
  readonly action: ShellBrowserCommand["action"];
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

export type ShellBrowserOutcome =
  | { readonly ok: true; readonly page: BrowserPageOutcome }
  | { readonly ok: false; readonly error: string };

/**
 * What the shell can do to a computer. Paths arrive already resolved to
 * absolute paths; the world decides what exists and raises `ShellIoError` with
 * an operator-safe message when an operation cannot complete.
 */
export interface ShellWorld {
  readonly cwd: string;
  fileInfo(
    path: string,
  ): { readonly kind: "file"; readonly bytes: number } | { readonly kind: "dir" } | undefined;
  readFile(path: string): Uint8Array;
  listDirectory(path: string, includeHidden: boolean): readonly DirectoryEntry[];
  writeFile(path: string, content: Uint8Array, append: boolean): void;
  makeDirectory(path: string, recursive: boolean): void;
  remove(path: string, recursive: boolean, force: boolean): void;
  move(from: string, to: string): void;
  copy(from: string, to: string, recursive: boolean): void;
  browser(command: ShellBrowserCommand): ShellBrowserOutcome;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OPERATORS = [">>", "2>>", "&&", "||", "|", ";", "2>", ">"] as const;

/** Unquoted syntax a real shell acts on and this subset refuses to guess at. */
const UNSUPPORTED_CHARACTERS: Readonly<Record<string, string>> = {
  $: "variable expansion is not supported; pass the value directly",
  "`": "command substitution is not supported; run the command separately",
  "&": "background jobs are not supported",
  "<": "input redirection is not supported; read the file with cat",
};

interface PipelineSegment {
  readonly words: readonly string[];
  readonly redirect: { readonly target: string; readonly append: boolean } | undefined;
  /** `2>` / `2>>`: where stderr goes, when a caller asks for it explicitly. */
  readonly stderrRedirect: { readonly target: string; readonly append: boolean } | undefined;
}

type ShellItem =
  | { readonly kind: "pipeline"; readonly segments: readonly PipelineSegment[] }
  | { readonly kind: "and" }
  | { readonly kind: "or" }
  | { readonly kind: "sequence" };

interface CommandOutcome {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
}

type CommandHandler = (
  world: ShellWorld,
  args: readonly string[],
  stdin: Uint8Array,
  context: { readonly timeoutMs: number },
) => CommandOutcome;

/**
 * Resolves a command's path argument the way the shell does: an absolute path
 * stands alone, a relative one resolves against the working directory, and
 * `.` and `..` are folded without ever escaping the root.
 */
export function resolveShellPath(cwd: string, input: string): string {
  const parts = input.startsWith("/") ? [] : cwd.split("/").filter((part) => part !== "");

  for (const part of input.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }

    if (part === "..") {
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return `/${parts.join("/")}`;
}

function tokenize(source: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let index = 0;

  const flush = (): void => {
    if (started) {
      tokens.push(current);
      current = "";
      started = false;
    }
  };

  while (index < source.length) {
    const character = source[index] ?? "";

    if (character === "'") {
      started = true;
      index += 1;

      while (index < source.length && source[index] !== "'") {
        current += source[index];
        index += 1;
      }

      if (index >= source.length) {
        throw new ShellSyntaxError("unterminated single quote");
      }

      index += 1;
      continue;
    }

    if (character === '"') {
      started = true;
      index += 1;

      while (index < source.length && source[index] !== '"') {
        const inner = source[index] ?? "";

        if (inner === "\\" && (source[index + 1] === '"' || source[index + 1] === "\\")) {
          current += source[index + 1];
          index += 2;
          continue;
        }

        // A real shell expands these inside double quotes too, so the subset
        // refuses them here rather than promising literal text it would not
        // deliver on a real machine.
        if (inner === "$" || inner === "`") {
          throw new ShellSyntaxError(
            `"${inner}" is not supported inside double quotes: expansion is not implemented`,
          );
        }

        current += inner;
        index += 1;
      }

      if (index >= source.length) {
        throw new ShellSyntaxError("unterminated double quote");
      }

      index += 1;
      continue;
    }

    if (character === "\\" && index + 1 < source.length) {
      started = true;
      current += source[index + 1];
      index += 2;
      continue;
    }

    const operator = OPERATORS.find(
      (candidate) =>
        source.startsWith(candidate, index) && (candidate !== ">" || source[index + 1] !== ">"),
    );

    if (operator !== undefined) {
      flush();
      tokens.push(operator);
      index += operator.length;
      continue;
    }

    const unsupported = UNSUPPORTED_CHARACTERS[character];

    if (unsupported !== undefined) {
      throw new ShellSyntaxError(`"${character}" is not supported: ${unsupported}`);
    }

    if (/\s/.test(character)) {
      flush();
      index += 1;
      continue;
    }

    started = true;
    current += character;
    index += 1;
  }

  flush();
  return tokens;
}

function parse(source: string): readonly ShellItem[] {
  const tokens = tokenize(source);
  const items: ShellItem[] = [];
  let segments: PipelineSegment[] = [];
  let words: string[] = [];
  let redirect: PipelineSegment["redirect"];
  let stderrRedirect: PipelineSegment["stderrRedirect"];

  const endSegment = (): void => {
    segments.push({ words, redirect, stderrRedirect });
    words = [];
    redirect = undefined;
    stderrRedirect = undefined;
  };

  const endPipeline = (): void => {
    if (segments.length === 0 && words.length === 0 && redirect === undefined) {
      return;
    }

    endSegment();
    items.push({ kind: "pipeline", segments });
    segments = [];
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined) {
      continue;
    }

    if (token === "|") {
      endSegment();
      continue;
    }

    if (token === ">" || token === ">>" || token === "2>" || token === "2>>") {
      const target = tokens[index + 1];

      if (target === undefined || (OPERATORS as readonly string[]).includes(target)) {
        throw new ShellSyntaxError(`a redirection needs a target path after "${token}"`);
      }

      const append = token.endsWith(">>");

      if (token.startsWith("2")) {
        stderrRedirect = { target, append };
      } else {
        redirect = { target, append };
      }

      index += 1;
      continue;
    }

    if (token === "&&" || token === "||" || token === ";") {
      endPipeline();
      items.push(
        token === "&&" ? { kind: "and" } : token === "||" ? { kind: "or" } : { kind: "sequence" },
      );
      continue;
    }

    words.push(token);
  }

  if (
    words.length > 0 ||
    redirect !== undefined ||
    stderrRedirect !== undefined ||
    segments.length > 0
  ) {
    endPipeline();
  }

  return items;
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function text(input: Uint8Array): string {
  return decoder.decode(input);
}

function output(value: string): CommandOutcome {
  return { stdout: bytes(value), stderr: "", exitCode: 0 };
}

function failure(message: string, exitCode = 1): CommandOutcome {
  return { stdout: new Uint8Array(0), stderr: `${message}\n`, exitCode };
}

function join(args: readonly string[], separator = " "): string {
  return args.join(separator);
}

/**
 * Parses leading flags the way the subset supports them: combined single-letter
 * flags (`-rf`), long flags, `--` to end options, and positional arguments after
 * them. An unknown flag is an error rather than a silently ignored argument.
 */
function parseFlags(
  args: readonly string[],
  short: readonly string[],
  long: readonly string[] = [],
): {
  readonly flags: ReadonlySet<string>;
  readonly positional: readonly string[];
  readonly error?: string;
} {
  const flags = new Set<string>();
  const positional: string[] = [];
  let endOfOptions = false;

  for (const argument of args) {
    if (endOfOptions || !argument.startsWith("-") || argument === "-") {
      positional.push(argument);
      continue;
    }

    if (argument === "--") {
      endOfOptions = true;
      continue;
    }

    if (argument.startsWith("--")) {
      const name = argument.slice(2);

      if (!long.includes(name)) {
        return { flags, positional, error: `unrecognized option "${argument}"` };
      }

      flags.add(name);
      continue;
    }

    for (const letter of argument.slice(1)) {
      if (!short.includes(letter)) {
        return { flags, positional, error: `invalid option -- "${letter}"` };
      }

      flags.add(letter);
    }
  }

  return { flags, positional };
}

function escapeCharacter(character: string): string {
  switch (character) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    default:
      return `\\${character}`;
  }
}

function printfOnce(
  format: string,
  args: readonly string[],
  cursor: { index: number },
): { readonly text: string; readonly consumedArgument: boolean } {
  let result = "";
  let index = 0;
  let consumedArgument = false;

  while (index < format.length) {
    const character = format[index] ?? "";

    if (character === "\\" && index + 1 < format.length) {
      result += escapeCharacter(format[index + 1] ?? "");
      index += 2;
      continue;
    }

    if (character === "%" && index + 1 < format.length) {
      const specifier = format[index + 1] ?? "";

      if (specifier === "%") {
        result += "%";
      } else if (specifier === "s") {
        result += args[cursor.index] ?? "";
        cursor.index += 1;
        consumedArgument = true;
      } else if (specifier === "d") {
        const parsed = Number.parseInt(args[cursor.index] ?? "0", 10);
        result += String(Number.isNaN(parsed) ? 0 : parsed);
        cursor.index += 1;
        consumedArgument = true;
      } else {
        result += `%${specifier}`;
      }

      index += 2;
      continue;
    }

    result += character;
    index += 1;
  }

  return { text: result, consumedArgument };
}

/**
 * POSIX printf reuses the format while arguments remain, so
 * `printf '%s\n' a b` writes two lines. A format that consumes no argument
 * (only `%%`, say) is applied once rather than spinning forever.
 */
function formatPrintf(format: string, args: readonly string[]): string {
  const cursor = { index: 0 };
  let first = printfOnce(format, args, cursor);
  let result = first.text;

  while (first.consumedArgument && cursor.index < args.length) {
    first = printfOnce(format, args, cursor);
    result += first.text;
  }

  return result;
}

function formatSize(size: number): string {
  return String(size).padStart(12);
}

const commands: Readonly<Record<string, CommandHandler>> = {
  pwd: (world) => output(`${world.cwd}\n`),

  echo: (_world, args) => {
    const newline = args[0] !== "-n";
    const words = newline ? args : args.slice(1);

    return output(`${join(words)}${newline ? "\n" : ""}`);
  },

  printf: (_world, args) => {
    const format = args[0];

    if (format === undefined) {
      return failure("printf: usage: printf FORMAT [ARGUMENT...]");
    }

    return output(formatPrintf(format, args.slice(1)));
  },

  cat: (world, args, stdin) => {
    const parsed = parseFlags(args, [], []);

    if (parsed.error !== undefined) {
      return failure(`cat: ${parsed.error}`);
    }

    if (parsed.positional.length === 0) {
      return { stdout: stdin, stderr: "", exitCode: 0 };
    }

    const chunks: Uint8Array[] = [];
    let stderr = "";
    let exitCode = 0;

    for (const argument of parsed.positional) {
      const path = resolveShellPath(world.cwd, argument);
      const info = world.fileInfo(path);

      if (info === undefined || info.kind === "dir") {
        stderr += `cat: ${argument}: ${info === undefined ? "No such file or directory" : "Is a directory"}\n`;
        exitCode = 1;
        continue;
      }

      chunks.push(world.readFile(path));
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return { stdout: joined, stderr, exitCode };
  },

  ls: (world, args) => {
    const parsed = parseFlags(args, ["a", "l", "1"], []);

    if (parsed.error !== undefined) {
      return failure(`ls: ${parsed.error}`);
    }

    const targets = parsed.positional.length === 0 ? [world.cwd] : parsed.positional;
    const lines: string[] = [];
    let stderr = "";
    let exitCode = 0;

    for (const argument of targets) {
      const path = resolveShellPath(world.cwd, argument);
      const info = world.fileInfo(path);

      if (info === undefined) {
        stderr += `ls: cannot access '${argument}': No such file or directory\n`;
        exitCode = 2;
        continue;
      }

      if (info.kind === "file") {
        lines.push(basename(path));
        continue;
      }

      for (const entry of world.listDirectory(path, parsed.flags.has("a"))) {
        if (parsed.flags.has("l")) {
          const kind = entry.kind === "dir" ? "drwxr-xr-x" : "-rw-r--r--";
          lines.push(
            `${kind} 1 agent agent ${formatSize(entry.bytes)} 1970-01-01 00:00 ${entry.name}`,
          );
        } else {
          lines.push(entry.name);
        }
      }
    }

    return {
      stdout: bytes(lines.length === 0 ? "" : `${lines.join("\n")}\n`),
      stderr,
      exitCode,
    };
  },

  mkdir: (world, args) => {
    const parsed = parseFlags(args, ["p"], []);

    if (parsed.error !== undefined) {
      return failure(`mkdir: ${parsed.error}`);
    }

    if (parsed.positional.length === 0) {
      return failure("mkdir: missing operand");
    }

    for (const argument of parsed.positional) {
      const path = resolveShellPath(world.cwd, argument);

      if (!parsed.flags.has("p")) {
        const parent = dirname(path);
        const parentInfo = world.fileInfo(parent);

        if (parentInfo === undefined || parentInfo.kind !== "dir") {
          return failure(`mkdir: cannot create directory '${argument}': No such file or directory`);
        }
      }

      world.makeDirectory(path, parsed.flags.has("p"));
    }

    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  },

  rm: (world, args) => {
    const parsed = parseFlags(args, ["r", "R", "f"], []);

    if (parsed.error !== undefined) {
      return failure(`rm: ${parsed.error}`);
    }

    if (parsed.positional.length === 0) {
      return failure("rm: missing operand");
    }

    for (const argument of parsed.positional) {
      const path = resolveShellPath(world.cwd, argument);

      try {
        world.remove(path, parsed.flags.has("r") || parsed.flags.has("R"), parsed.flags.has("f"));
      } catch (error) {
        if (error instanceof ShellIoError) {
          return failure(`rm: cannot remove '${argument}': ${error.message}`);
        }

        throw error;
      }
    }

    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  },

  mv: (world, args) => {
    const parsed = parseFlags(args, [], []);

    if (parsed.error !== undefined) {
      return failure(`mv: ${parsed.error}`);
    }

    if (parsed.positional.length !== 2) {
      return failure("mv: usage: mv SOURCE DESTINATION");
    }

    const [from, to] = parsed.positional;

    try {
      world.move(resolveShellPath(world.cwd, from ?? ""), resolveShellPath(world.cwd, to ?? ""));
    } catch (error) {
      if (error instanceof ShellIoError) {
        return failure(`mv: cannot move '${from}': ${error.message}`);
      }

      throw error;
    }

    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  },

  cp: (world, args) => {
    const parsed = parseFlags(args, ["r", "R"], []);

    if (parsed.error !== undefined) {
      return failure(`cp: ${parsed.error}`);
    }

    if (parsed.positional.length !== 2) {
      return failure("cp: usage: cp SOURCE DESTINATION");
    }

    const [from, to] = parsed.positional;

    try {
      world.copy(
        resolveShellPath(world.cwd, from ?? ""),
        resolveShellPath(world.cwd, to ?? ""),
        parsed.flags.has("r") || parsed.flags.has("R"),
      );
    } catch (error) {
      if (error instanceof ShellIoError) {
        return failure(`cp: cannot copy '${from}': ${error.message}`);
      }

      throw error;
    }

    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  },

  true: () => ({ stdout: new Uint8Array(0), stderr: "", exitCode: 0 }),

  false: () => ({ stdout: new Uint8Array(0), stderr: "", exitCode: 1 }),

  sleep: (_world, args, _stdin, context) => {
    const seconds = Number.parseFloat(args[0] ?? "");

    if (!Number.isFinite(seconds) || seconds < 0 || args.length !== 1) {
      return failure("sleep: usage: sleep SECONDS");
    }

    if (seconds * 1_000 > context.timeoutMs) {
      throw new ComputerProviderError(
        "timed_out",
        `the command budget of ${context.timeoutMs}ms cannot cover "sleep ${args[0] ?? ""}"`,
      );
    }

    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  },

  base64: (world, args, stdin) => {
    const parsed = parseFlags(args, ["d"], ["decode"]);

    if (parsed.error !== undefined) {
      return failure(`base64: ${parsed.error}`);
    }

    let input: Uint8Array;

    if (parsed.positional.length === 0) {
      input = stdin;
    } else {
      const argument = parsed.positional[0] ?? "";
      const path = resolveShellPath(world.cwd, argument);
      const info = world.fileInfo(path);

      if (info === undefined || info.kind === "dir") {
        return failure(`base64: ${argument}: No such file or directory`);
      }

      input = world.readFile(path);
    }

    if (parsed.flags.has("d") || parsed.flags.has("decode")) {
      const compact = text(input).replace(/\s+/g, "");

      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
        return failure("base64: invalid input");
      }

      return { stdout: new Uint8Array(Buffer.from(compact, "base64")), stderr: "", exitCode: 0 };
    }

    return output(`${Buffer.from(input).toString("base64")}\n`);
  },

  /**
   * The archive pair the snapshot path uses: `tar -cf <archive> -C <dir>
   * <member...>` packs files (and the directories their names imply) into the
   * shared ustar format, and `tar -xf <archive> -C <dir>` unpacks them. The
   * cloud provider's snapshot runs through this command on the machine itself,
   * exactly as a real image's `tar` would, which is why the shell carries it.
   */
  tar: (world, args) => {
    let mode: "create" | "extract" | undefined;
    let archive: string | undefined;
    let directory = world.cwd;
    const members: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index] ?? "";

      if (!argument.startsWith("-") || argument === "-") {
        members.push(argument);
        continue;
      }

      const letters = argument.slice(1);

      for (let cursor = 0; cursor < letters.length; cursor += 1) {
        const letter = letters[cursor] ?? "";

        if (letter === "c") {
          mode = "create";
          continue;
        }

        if (letter === "x") {
          mode = "extract";
          continue;
        }

        if (letter === "v") {
          continue;
        }

        if (letter === "f" || letter === "C") {
          const attached = letters.slice(cursor + 1);
          const value = attached === "" ? args[index + 1] : attached;

          if (attached === "") {
            index += 1;
          }

          if (value === undefined) {
            return failure(`tar: option requires an argument -- '${letter}'`);
          }

          if (letter === "f") {
            archive = value;
          } else {
            directory = resolveShellPath(world.cwd, value);
          }

          cursor = letters.length;
          continue;
        }

        return failure(`tar: invalid option -- '${letter}'`);
      }
    }

    if (archive === undefined) {
      return failure("tar: an archive file is required with -f");
    }

    const archivePath = resolveShellPath(world.cwd, archive);

    if (mode === "extract") {
      const info = world.fileInfo(archivePath);

      if (info === undefined || info.kind !== "file") {
        return failure(`tar: ${archive}: No such file or directory`);
      }

      for (const entry of readTar(Buffer.from(world.readFile(archivePath)))) {
        const name = entry.name.replace(/^\.\/+/, "");

        if (name === "" || name.endsWith("/")) {
          continue;
        }

        const target = resolveShellPath(directory, name);
        const parent = target.slice(0, target.lastIndexOf("/"));

        if (parent !== "") {
          world.makeDirectory(parent, true);
        }

        world.writeFile(target, entry.content, false);
      }

      return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
    }

    if (mode === "create") {
      const entries: { readonly name: string; readonly content: Uint8Array }[] = [];

      const visit = (path: string, name: string): string | undefined => {
        const info = world.fileInfo(path);

        if (info === undefined) {
          return `${name}: No such file or directory`;
        }

        if (info.kind === "file") {
          entries.push({ name, content: world.readFile(path) });
          return undefined;
        }

        for (const child of world.listDirectory(path, true)) {
          const childPath = path === "/" ? `/${child.name}` : `${path}/${child.name}`;
          const childName =
            name === ""
              ? `./${child.name}`
              : name.endsWith("/")
                ? `${name}${child.name}`
                : `${name}/${child.name}`;
          const problem = visit(childPath, childName);

          if (problem !== undefined) {
            return problem;
          }
        }

        return undefined;
      };

      for (const member of members.length === 0 ? ["."] : members) {
        const start = resolveShellPath(directory, member);
        const problem = visit(start, member === "." ? "./" : member);

        if (problem !== undefined) {
          return failure(`tar: ${problem}`);
        }
      }

      world.writeFile(archivePath, writeTar(entries), false);
      return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
    }

    return failure("tar: exactly one of -c or -x is required");
  },

  /**
   * `sh -c '<command>'`: the one door a provider needs when it has to group
   * and redirect a caller's command as a single unit. The command string runs
   * through the same parser and command set, so `sh -c` adds no new shell; it
   * only nests one.
   */
  sh: (world, args, _stdin, context) => {
    const parsed = parseFlags(args, ["c"], []);

    if (parsed.error !== undefined) {
      return failure(`sh: ${parsed.error}`);
    }

    if (!parsed.flags.has("c")) {
      return failure("sh: only -c is supported");
    }

    const source = parsed.positional[0];

    if (source === undefined) {
      return failure("sh: -c requires a command string");
    }

    const result = runShellCommand(world, source, context);

    return { stdout: bytes(result.stdout), stderr: result.stderr, exitCode: result.exitCode };
  },

  browser: (world, args) => {
    if (args.length !== 1) {
      return failure("browser: usage: browser '{\"action\":...}'");
    }

    let request: unknown;

    try {
      request = JSON.parse(args[0] ?? "");
    } catch {
      return failure("browser: the argument must be a JSON object");
    }

    const parsed = parseBrowserCommand(request);

    if (parsed.error !== undefined) {
      return failure(`browser: ${parsed.error}`);
    }

    const outcome = world.browser(parsed.command);

    if (!outcome.ok) {
      return {
        stdout: bytes(`${JSON.stringify({ ok: false, error: outcome.error })}\n`),
        stderr: "",
        exitCode: 1,
      };
    }

    const payload = {
      ok: true,
      action: outcome.page.action,
      url: outcome.page.url,
      title: outcome.page.title,
      text: outcome.page.text,
    };

    return output(`${JSON.stringify(payload)}\n`);
  },
};

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");

  return parts.at(-1) ?? "";
}

function dirname(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  parts.pop();

  return `/${parts.join("/")}`;
}

function parseBrowserCommand(
  value: unknown,
):
  | { readonly command: ShellBrowserCommand; readonly error?: undefined }
  | { readonly command?: undefined; readonly error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "the argument must be a JSON object" };
  }

  const record = value as Record<string, unknown>;
  const action = record["action"];

  if (action === "open") {
    const url = record["url"];

    return typeof url === "string" && url.trim() !== ""
      ? { command: { action: "open", url } }
      : { error: 'action "open" needs a url' };
  }

  if (action === "click") {
    const selector = record["selector"];

    return typeof selector === "string" && selector.trim() !== ""
      ? { command: { action: "click", selector } }
      : { error: 'action "click" needs a selector' };
  }

  if (action === "type") {
    const selector = record["selector"];
    const content = record["text"];

    return typeof selector === "string" && selector.trim() !== "" && typeof content === "string"
      ? { command: { action: "type", selector, text: content } }
      : { error: 'action "type" needs a selector and text' };
  }

  if (action === "read") {
    return { command: { action: "read" } };
  }

  return { error: 'action must be one of "open", "click", "type" or "read"' };
}

function executeSegment(
  world: ShellWorld,
  segment: PipelineSegment,
  stdin: Uint8Array,
  timeoutMs: number,
): CommandOutcome {
  const [name, ...args] = segment.words;

  if (name === undefined) {
    return { stdout: new Uint8Array(0), stderr: "", exitCode: 0 };
  }

  const handler = commands[name];

  if (handler === undefined) {
    return { stdout: new Uint8Array(0), stderr: `${name}: command not found\n`, exitCode: 127 };
  }

  try {
    return handler(world, args, stdin, { timeoutMs });
  } catch (error) {
    if (error instanceof ShellIoError) {
      return failure(`${name}: ${error.message}`);
    }

    throw error;
  }
}

function executePipeline(
  world: ShellWorld,
  segments: readonly PipelineSegment[],
  timeoutMs: number,
): { readonly stdout: string; readonly stderr: string; readonly exitCode: number } {
  let stdin: Uint8Array = new Uint8Array(0);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? {
      words: [],
      redirect: undefined,
      stderrRedirect: undefined,
    };
    const outcome = executeSegment(world, segment, stdin, timeoutMs);
    exitCode = outcome.exitCode;

    if (segment.stderrRedirect !== undefined) {
      const target = resolveShellPath(world.cwd, segment.stderrRedirect.target);

      try {
        world.writeFile(target, bytes(outcome.stderr), segment.stderrRedirect.append);
      } catch (error) {
        if (!(error instanceof ShellIoError)) {
          throw error;
        }

        return {
          stdout,
          stderr: `${stderr}${segment.stderrRedirect.target}: ${error.message}\n`,
          exitCode: 1,
        };
      }
    } else {
      stderr += outcome.stderr;
    }

    let piped: Uint8Array = outcome.stdout;

    if (segment.redirect !== undefined) {
      const target = resolveShellPath(world.cwd, segment.redirect.target);

      try {
        world.writeFile(target, outcome.stdout, segment.redirect.append);
      } catch (error) {
        if (!(error instanceof ShellIoError)) {
          throw error;
        }

        return {
          stdout,
          stderr: `${stderr}${segment.redirect.target}: ${error.message}\n`,
          exitCode: 1,
        };
      }

      piped = new Uint8Array(0);
    }

    if (index === segments.length - 1) {
      stdout += text(piped);
    }

    stdin = piped;
  }

  return { stdout, stderr, exitCode };
}

export function runShellCommand(
  world: ShellWorld,
  source: string,
  options: { readonly timeoutMs: number },
): ShellResult {
  let items: readonly ShellItem[];

  try {
    items = parse(source);
  } catch (error) {
    if (error instanceof ShellSyntaxError) {
      // A syntax error is a shell result, not a provider failure: the caller
      // gets the exit code and the message a real shell would print.
      return { exitCode: 2, stdout: "", stderr: `porkbot-sh: ${error.message}\n` };
    }

    throw error;
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode = 0;
  let shouldRun = true;

  for (const item of items) {
    // A list runs the next pipeline only when the operator's condition holds
    // against the last pipeline that actually ran, so `false && a || b` runs
    // `b` exactly as a POSIX shell does.
    if (item.kind === "and") {
      shouldRun = exitCode === 0;
      continue;
    }

    if (item.kind === "or") {
      shouldRun = exitCode !== 0;
      continue;
    }

    if (item.kind === "sequence") {
      shouldRun = true;
      continue;
    }

    if (!shouldRun) {
      continue;
    }

    const outcome = executePipeline(world, item.segments, options.timeoutMs);
    stdout.push(outcome.stdout);
    stderr.push(outcome.stderr);
    exitCode = outcome.exitCode;
  }

  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

export { basename, dirname };

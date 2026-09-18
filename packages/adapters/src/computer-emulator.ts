import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerFrame,
  ComputerInput,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import { basename, dirname, runShellCommand, ShellIoError } from "./computer-shell.ts";
import type {
  DirectoryEntry,
  ShellBrowserCommand,
  ShellBrowserOutcome,
  ShellWorld,
} from "./computer-shell.ts";

/**
 * The offline computer: a deterministic machine behind the `ComputerProvider`
 * seam with a filesystem, a bounded shell and a scripted browser (slice 6.9,
 * PRD decisions 20 and 30; stories 27–30). It is the third implementation the
 * seam names, after local Docker (7.2) and one cloud provider (7.3), and the
 * one the product runs on with no daemon, no key and no network, so the whole
 * tool path — shell, files, browser — is executable in a test and in the
 * first end-to-end run.
 *
 * State is in-process and keyed by the `ComputerRef`'s `computerId`: each
 * computer has its own filesystem, browser session and snapshot set, and
 * nothing here ever touches the host's filesystem. State persists across
 * `exec` calls for the life of the emulator, so a file written by one tool is
 * the file the next tool reads; `destroy` removes the machine, and a snapshot
 * taken before it restores into a fresh one.
 *
 * Commands cross the seam exactly as they cross a real machine's shell: a
 * string in, exit code and streams out. The shell subset is documented in
 * `computer-shell.ts`, and the browser is a machine-local command — `browser
 * '{"action":"open",...}'` — whose stdout is a JSON page record. The file and
 * browser tools are built on those commands, so the same tool code reaches
 * this emulator and a real container.
 *
 * Determinism: scripting is data, page and action lookups are normalized, ids
 * come from a monotone sequence, the clock is injected (epoch by default), and
 * listing order is sorted, so the same script produces the same bytes, exit
 * codes and frames every run.
 */

/** The home directory every emulated computer starts in unless told otherwise. */
export const DEFAULT_COMPUTER_HOME = "/home/agent";

const encoder = new TextEncoder();

interface FileNode {
  readonly kind: "file";
  readonly content: Uint8Array;
}

interface DirectoryNode {
  readonly kind: "dir";
}

type Node = FileNode | DirectoryNode;

interface BrowserSession {
  currentUrl: string | undefined;
  readonly typed: Map<string, string>;
  typedBuffer: string;
}

interface BrowserActionScript {
  readonly url: string;
  readonly selector: string;
  readonly action: "click" | "type";
  readonly target: string | undefined;
}

interface ComputerInstance {
  state: "running" | "stopped";
  generation: number;
  readonly files: Map<string, Node>;
  readonly browser: BrowserSession;
}

/** One page the scripted browser can serve, keyed by its normalized URL. */
export interface EmulatedComputerPage {
  /** Absolute URL the page is served at, as the browser would request it. */
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

/** One action a scripted page element answers. `click` may navigate. */
export interface EmulatedBrowserAction {
  /** The page the element lives on. */
  readonly url: string;
  readonly selector: string;
  readonly action: "click" | "type";
  /** Where a click navigates, when it does. Ignored for `type`. */
  readonly target?: string | undefined;
}

/** One browser action the emulator received, for assertions by position. */
export interface RecordedBrowserAction {
  readonly action: "open" | "click" | "type" | "read";
  readonly url?: string | undefined;
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
}

export interface ComputerEmulatorOptions {
  /** The agent's home directory; defaults to `DEFAULT_COMPUTER_HOME`. */
  readonly home?: string | undefined;
  /** Wall-clock milliseconds for frame timestamps; defaults to the epoch. */
  readonly now?: (() => number) | undefined;
}

function normalizeUrl(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The screen one frame captures: the current page and whatever the reserved
 * input path has typed since. The SVG is a deterministic rendering of that
 * state, not a picture of a real display, which is what makes the reserved
 * `frames()` path assertable offline.
 */
function screenSvg(state: {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly typed: string;
}): string {
  const lines = [state.url, state.title, "", ...state.text.split("\n")];

  if (state.typed !== "") {
    lines.push("", `> ${state.typed}`);
  }

  const spans = lines
    .map((line, index) => `<tspan x="8" dy="${index === 0 ? 0 : 16}">${escapeXml(line)}</tspan>`)
    .join("");

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#111111"/>' +
    '<text x="8" y="24" fill="#eeeeee" font-family="monospace" font-size="13">' +
    spans +
    "</text></svg>"
  );
}

export class ComputerEmulator implements ComputerProvider {
  readonly #home: string;
  readonly #now: () => number;
  readonly #instances = new Map<string, ComputerInstance>();
  readonly #snapshots = new Map<
    string,
    { readonly snapshotId: string; readonly instance: ComputerInstance }
  >();
  readonly #pages = new Map<string, EmulatedComputerPage>();
  readonly #actions = new Map<string, BrowserActionScript>();
  readonly #executedCommands: ComputerExecRequest[] = [];
  readonly #browserActions: RecordedBrowserAction[] = [];
  readonly #inputs: ComputerInput[] = [];
  #nextSnapshot = 1;
  #nextGeneration = 1;

  constructor(options: ComputerEmulatorOptions = {}) {
    this.#home = options.home ?? DEFAULT_COMPUTER_HOME;
    this.#now = options.now ?? (() => 0);

    if (!this.#home.startsWith("/") || this.#home === "/") {
      throw new RangeError(
        `home must be an absolute path below the root, received "${this.#home}"`,
      );
    }
  }

  /** Every command received, oldest first. */
  get commands(): readonly ComputerExecRequest[] {
    return this.#executedCommands;
  }

  /** Every browser action received, oldest first. */
  get browserActions(): readonly RecordedBrowserAction[] {
    return this.#browserActions;
  }

  /** Every reserved input event received, oldest first. */
  get inputs(): readonly ComputerInput[] {
    return this.#inputs;
  }

  /** Serve one page; the last registration for a normalized URL wins. */
  servePage(page: EmulatedComputerPage): this {
    const url = normalizeUrl(page.url);

    if (url === undefined) {
      throw new RangeError(`servePage needs an absolute URL, received "${page.url}"`);
    }

    this.#pages.set(url, { url, title: page.title, text: page.text });
    return this;
  }

  /** Script one element action; the last registration for a selector wins. */
  serveBrowserAction(action: EmulatedBrowserAction): this {
    const url = normalizeUrl(action.url);

    if (url === undefined) {
      throw new RangeError(`serveBrowserAction needs an absolute URL, received "${action.url}"`);
    }

    if (action.selector.trim() === "") {
      throw new RangeError("serveBrowserAction needs a non-blank selector");
    }

    const target = action.target === undefined ? undefined : normalizeUrl(action.target);

    if (action.target !== undefined && target === undefined) {
      throw new RangeError(
        `serveBrowserAction needs an absolute target, received "${action.target}"`,
      );
    }

    this.#actions.set(`${url}\u0000${action.selector}`, {
      url,
      selector: action.selector,
      action: action.action,
      target,
    });
    return this;
  }

  /** Park a computer without removing it; `ensure` starts it again. */
  stop(computer: ComputerRef): this {
    const instance = this.#instances.get(computer.computerId);

    if (instance !== undefined) {
      instance.state = "stopped";
    }

    return this;
  }

  async ensure(computer: ComputerRef): Promise<ComputerStatus> {
    const existing = this.#instances.get(computer.computerId);

    if (existing === undefined) {
      this.#instances.set(computer.computerId, this.#createInstance());
    } else if (existing.state === "stopped") {
      existing.state = "running";
      existing.generation = this.#nextGeneration;
      this.#nextGeneration += 1;
    }

    return this.#status(computer);
  }

  async status(computer: ComputerRef): Promise<ComputerStatus> {
    return this.#status(computer);
  }

  async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new RangeError(
        `timeoutMs must be a positive integer of milliseconds, received ${String(request.timeoutMs)}`,
      );
    }

    const instance = this.#running(request.computer);
    this.#executedCommands.push({ ...request });

    return runShellCommand(this.#world(instance), request.command, {
      timeoutMs: request.timeoutMs,
    });
  }

  async snapshot(computer: ComputerRef): Promise<ComputerSnapshot> {
    const instance = this.#running(computer);
    const snapshotId = `snapshot-${this.#nextSnapshot}`;
    this.#nextSnapshot += 1;

    const key = `computer-snapshots/${computer.computerId}/${snapshotId}`;
    this.#snapshots.set(key, { snapshotId, instance: cloneInstance(instance) });

    return { snapshotId, key };
  }

  async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
    const saved = this.#snapshots.get(snapshot.key);

    // The id and the key must name the same stored snapshot: a hand-assembled
    // pair is refused rather than silently resolving to whatever the key holds.
    if (saved === undefined || saved.snapshotId !== snapshot.snapshotId) {
      throw new ComputerProviderError(
        "not_found",
        `no snapshot is stored at "${snapshot.key}"; it was never taken or the emulator is another process`,
      );
    }

    const instance = cloneInstance(saved.instance);
    instance.state = "running";
    instance.generation = this.#nextGeneration;
    this.#nextGeneration += 1;
    this.#instances.set(computer.computerId, instance);

    return this.#status(computer);
  }

  async destroy(computer: ComputerRef): Promise<void> {
    this.#instances.delete(computer.computerId);
  }

  /** Reserved for v1.1 screen watch: one deterministic frame of the current screen. */
  async *frames(computer: ComputerRef): AsyncIterable<ComputerFrame> {
    const instance = this.#running(computer);
    const page = this.#currentPage(instance);

    yield {
      capturedAt: new Date(this.#now()).toISOString(),
      mediaType: "image/svg+xml",
      data: encoder.encode(
        screenSvg({
          url: instance.browser.currentUrl ?? "about:blank",
          title: page?.title ?? "",
          text: page?.text ?? "",
          typed: instance.browser.typedBuffer,
        }),
      ),
    };
  }

  /** Reserved for v1.1 screen takeover: recorded, and text is visible to `frames`. */
  async input(computer: ComputerRef, input: ComputerInput): Promise<void> {
    const instance = this.#running(computer);
    this.#inputs.push(input);

    if (input.type === "key") {
      instance.browser.typedBuffer += input.key;
    } else if (input.type === "text") {
      instance.browser.typedBuffer += input.text;
    }
  }

  #createInstance(): ComputerInstance {
    const instance = cloneInstance({
      state: "running",
      generation: this.#nextGeneration,
      files: new Map<string, Node>([["/", { kind: "dir" }]]),
      browser: { currentUrl: undefined, typed: new Map(), typedBuffer: "" },
    });
    this.#nextGeneration += 1;

    for (const path of ancestors(this.#home)) {
      instance.files.set(path, { kind: "dir" });
    }

    instance.files.set("/tmp", { kind: "dir" });
    return instance;
  }

  #status(computer: ComputerRef): ComputerStatus {
    const instance = this.#instances.get(computer.computerId);

    if (instance === undefined) {
      return { computer: { ...computer }, state: "gone" };
    }

    return {
      computer: { ...computer },
      state: instance.state,
      instanceId: `${computer.computerId}#${instance.generation}`,
    };
  }

  #running(computer: ComputerRef): ComputerInstance {
    const instance = this.#instances.get(computer.computerId);

    if (instance === undefined) {
      throw new ComputerProviderError(
        "gone",
        `no computer ${computer.computerId} is provisioned; bring one up with ensure`,
      );
    }

    if (instance.state !== "running") {
      throw new ComputerProviderError(
        "gone",
        `computer ${computer.computerId} is stopped; call ensure before running a command`,
      );
    }

    return instance;
  }

  #currentPage(instance: ComputerInstance): EmulatedComputerPage | undefined {
    const url = instance.browser.currentUrl;

    return url === undefined ? undefined : this.#pages.get(url);
  }

  #navigate(instance: ComputerInstance, url: string): EmulatedComputerPage | undefined {
    const page = this.#pages.get(url);

    if (page === undefined) {
      return undefined;
    }

    instance.browser.currentUrl = page.url;
    instance.browser.typedBuffer = "";
    return page;
  }

  #browserOutcome(instance: ComputerInstance, command: ShellBrowserCommand): ShellBrowserOutcome {
    this.#browserActions.push(browserRecord(command));

    if (command.action === "open") {
      const url = normalizeUrl(command.url);
      const page = url === undefined ? undefined : this.#navigate(instance, url);

      return page === undefined
        ? { ok: false, error: `no page is served at ${command.url}` }
        : { ok: true, page: pageOutcome(command.action, page) };
    }

    if (command.action === "read") {
      const page = this.#currentPage(instance);

      return page === undefined
        ? { ok: false, error: "no page is open; open one first" }
        : { ok: true, page: pageOutcome(command.action, page) };
    }

    const currentUrl = instance.browser.currentUrl;

    if (currentUrl === undefined) {
      return { ok: false, error: "no page is open; open one first" };
    }

    const scripted = this.#actions.get(`${currentUrl}\u0000${command.selector}`);

    if (scripted === undefined || scripted.action !== command.action) {
      return {
        ok: false,
        error: `no ${command.action} action is scripted for "${command.selector}"`,
      };
    }

    if (command.action === "type") {
      instance.browser.typed.set(command.selector, command.text);
      instance.browser.typedBuffer = command.text;
    }

    if (scripted.action === "click" && scripted.target !== undefined) {
      this.#navigate(instance, scripted.target);
    }

    const page = this.#currentPage(instance);

    return page === undefined
      ? { ok: false, error: "no page is open; open one first" }
      : { ok: true, page: pageOutcome(command.action, page) };
  }

  #world(instance: ComputerInstance): ShellWorld {
    return {
      cwd: this.#home,
      fileInfo: (path) => {
        const node = instance.files.get(path);

        return node === undefined
          ? undefined
          : node.kind === "file"
            ? { kind: "file", bytes: node.content.byteLength }
            : { kind: "dir" };
      },
      readFile: (path) => {
        const node = instance.files.get(path);

        if (node === undefined) {
          throw new ShellIoError(`${path}: No such file or directory`);
        }

        if (node.kind !== "file") {
          throw new ShellIoError(`${path}: Is a directory`);
        }

        return node.content;
      },
      listDirectory: (path, includeHidden) => listEntries(instance.files, path, includeHidden),
      writeFile: (path, content, append) => {
        const parent = dirname(path);
        const parentNode = instance.files.get(parent);

        if (parentNode === undefined || parentNode.kind !== "dir") {
          throw new ShellIoError("No such file or directory");
        }

        const existing = instance.files.get(path);

        if (existing !== undefined && existing.kind === "dir") {
          throw new ShellIoError("Is a directory");
        }

        const next =
          append && existing?.kind === "file"
            ? concat(existing.content, content)
            : new Uint8Array(content);
        instance.files.set(path, { kind: "file", content: next });
      },
      makeDirectory: (path, recursive) => {
        if (path === "/") {
          return;
        }

        const existing = instance.files.get(path);

        if (existing !== undefined) {
          if (existing.kind === "dir" && recursive) {
            return;
          }

          throw new ShellIoError("File exists");
        }

        const parent = dirname(path);
        const parentNode = instance.files.get(parent);

        if (parentNode === undefined || parentNode.kind !== "dir") {
          if (recursive) {
            for (const ancestor of ancestors(path)) {
              instance.files.set(ancestor, { kind: "dir" });
            }

            return;
          }

          throw new ShellIoError("No such file or directory");
        }

        instance.files.set(path, { kind: "dir" });
      },
      remove: (path, recursive, force) => {
        const node = instance.files.get(path);

        if (node === undefined) {
          if (force) {
            return;
          }

          throw new ShellIoError("No such file or directory");
        }

        if (path === "/") {
          throw new ShellIoError("refusing to remove the root directory");
        }

        // `rm` refuses a directory without `-r`, exactly as a real shell does,
        // so a tool that forgets the flag fails here and in a container alike.
        if (node.kind === "dir" && !recursive) {
          throw new ShellIoError("Is a directory");
        }

        for (const candidate of [...instance.files.keys()]) {
          if (candidate === path || candidate.startsWith(`${path}/`)) {
            instance.files.delete(candidate);
          }
        }
      },
      move: (from, to) => {
        const node = instance.files.get(from);

        if (node === undefined) {
          throw new ShellIoError("No such file or directory");
        }

        const destination = instance.files.get(to);
        const target =
          destination?.kind === "dir" ? `${to === "/" ? "" : to}/${basename(from)}` : to;

        if (target === from || target.startsWith(`${from}/`)) {
          throw new ShellIoError("cannot move a directory into itself");
        }

        if (destination !== undefined && destination.kind !== "dir" && node.kind === "dir") {
          throw new ShellIoError("File exists");
        }

        requireParentDirectory(instance.files, target);

        for (const [path, candidate] of [...instance.files.entries()]) {
          if (path === from || path.startsWith(`${from}/`)) {
            instance.files.delete(path);
            instance.files.set(`${target}${path.slice(from.length)}`, candidate);
          }
        }
      },
      copy: (from, to, recursive) => {
        const node = instance.files.get(from);

        if (node === undefined) {
          throw new ShellIoError("No such file or directory");
        }

        if (node.kind === "dir" && !recursive) {
          throw new ShellIoError("Is a directory");
        }

        const destination = instance.files.get(to);
        const target =
          destination?.kind === "dir" ? `${to === "/" ? "" : to}/${basename(from)}` : to;

        if (destination !== undefined && destination.kind !== "dir" && node.kind === "dir") {
          throw new ShellIoError("cannot overwrite non-directory with directory");
        }

        requireParentDirectory(instance.files, target);

        for (const [path, candidate] of cloneNodes(instance.files, from)) {
          const suffix = path === from ? "" : path.slice(from.length);
          instance.files.set(`${target}${suffix}`, candidate);
        }
      },
      browser: (command) => this.#browserOutcome(instance, command),
    };
  }
}

function pageOutcome(action: ShellBrowserCommand["action"], page: EmulatedComputerPage) {
  return { action, url: page.url, title: page.title, text: page.text };
}

function browserRecord(command: ShellBrowserCommand): RecordedBrowserAction {
  switch (command.action) {
    case "open":
      return { action: "open", url: command.url };
    case "click":
      return { action: "click", selector: command.selector };
    case "type":
      return { action: "type", selector: command.selector, text: command.text };
    case "read":
      return { action: "read" };
  }
}

/** Every ancestor directory of an absolute path, the root first. */
function ancestors(path: string): readonly string[] {
  const result: string[] = ["/"];

  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") {
      continue;
    }

    result.push(`${result.at(-1) === "/" ? "" : result.at(-1)}/${part}`);
  }

  return result;
}

/**
 * A move or a copy lands only where the parent already exists, exactly as
 * `mv` and `cp` do: writing an orphan entry would make a file that `ls` cannot
 * show and a real shell could not have produced.
 */
function requireParentDirectory(files: ReadonlyMap<string, Node>, target: string): void {
  const parent = files.get(dirname(target));

  if (parent === undefined || parent.kind !== "dir") {
    throw new ShellIoError("No such file or directory");
  }
}

function cloneNodes(files: ReadonlyMap<string, Node>, prefix: string): ReadonlyMap<string, Node> {
  const clones = new Map<string, Node>();
  const inside = (path: string): boolean =>
    prefix === "/" ? path.startsWith("/") : path === prefix || path.startsWith(`${prefix}/`);

  for (const [path, node] of files) {
    if (!inside(path)) {
      continue;
    }

    clones.set(
      path,
      node.kind === "file"
        ? { kind: "file", content: new Uint8Array(node.content) }
        : { kind: "dir" },
    );
  }

  return clones;
}

function cloneInstance(source: ComputerInstance): ComputerInstance {
  return {
    state: source.state,
    generation: source.generation,
    files: new Map(cloneNodes(source.files, "/")),
    browser: {
      currentUrl: source.browser.currentUrl,
      typed: new Map(source.browser.typed),
      typedBuffer: source.browser.typedBuffer,
    },
  };
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function listEntries(
  files: ReadonlyMap<string, Node>,
  path: string,
  includeHidden: boolean,
): readonly DirectoryEntry[] {
  const prefix = path === "/" ? "/" : `${path}/`;
  const entries: DirectoryEntry[] = [];

  for (const [candidate, node] of files) {
    if (!candidate.startsWith(prefix) || candidate === path) {
      continue;
    }

    const remainder = candidate.slice(prefix.length);

    if (
      remainder === "" ||
      remainder.includes("/") ||
      (!includeHidden && remainder.startsWith("."))
    ) {
      continue;
    }

    entries.push({
      name: remainder,
      kind: node.kind,
      bytes: node.kind === "file" ? node.content.byteLength : 0,
    });
  }

  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

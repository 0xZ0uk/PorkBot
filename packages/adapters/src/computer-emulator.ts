import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerFrame,
  ComputerInput,
  ComputerProvider,
  ComputerProxyEndpoint,
  ComputerProxyGrant,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
  CredentialProxyAdmin,
} from "@porkbot/adapter-kit";
import type { SafeFetch } from "@porkbot/effect";
import {
  createCredentialProxyServer,
  proxyGrantFileName,
  serializeProxyGrant,
} from "./credential-proxy.ts";
import type { CredentialProxyServer } from "./credential-proxy.ts";
import { ComputerProviderError } from "./computer-errors.ts";
import { computerSnapshotKey } from "./computer-snapshot-store.ts";
import { runShellCommand } from "./computer-shell.ts";
import type { ShellBrowserCommand, ShellBrowserOutcome, ShellWorld } from "./computer-shell.ts";
import { cloneFileSystem, createFileSystem, createShellWorld } from "./computer-shell-world.ts";
import type { FileSystemNode } from "./computer-shell-world.ts";

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
  readonly files: Map<string, FileSystemNode>;
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

/**
 * The emulated computer's credential proxy (slice 7.8, PRD decision 29). When
 * configured, every computer this emulator serves gets a real credential-proxy
 * server on loopback, so a run's grant, its capability token and its allowlist
 * are exercised over real HTTP with no daemon and no keys. The upstream leg is
 * injectable for the same reason the model emulator's endpoint is: a test can
 * record exactly what crossed the proxy's wire without leaving the process.
 */
export interface ComputerEmulatorProxyOptions {
  /** The HMAC key a run's capability tokens are signed with. */
  readonly tokenSecret: string | Uint8Array;
  /** The upstream leg; `safeFetch` by default, injected so tests record calls. */
  readonly fetch?: SafeFetch | undefined;
  /** The clock, in whole seconds; injected in tests. */
  readonly nowSeconds?: (() => number) | undefined;
}

export interface ComputerEmulatorOptions {
  /** The agent's home directory; defaults to `DEFAULT_COMPUTER_HOME`. */
  readonly home?: string | undefined;
  /** Wall-clock milliseconds for frame timestamps; defaults to the epoch. */
  readonly now?: (() => number) | undefined;
  /** Present, the emulator runs one real credential proxy per computer. */
  readonly proxy?: ComputerEmulatorProxyOptions | undefined;
}

/** One computer's running proxy: its server, its grant directory and the runs on it. */
interface EmulatedProxy {
  readonly server: CredentialProxyServer;
  readonly grantDir: string;
  readonly runIds: Set<string>;
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
  readonly #proxyOptions: ComputerEmulatorProxyOptions | undefined;
  /** One proxy per computer, created the first time a run asks for one. */
  readonly #proxies = new Map<string, EmulatedProxy>();
  /**
   * The credential-proxy administration (slice 7.8), present only when the
   * emulator was configured with a key. It runs the shipped proxy server, not
   * a mock: `grant` writes a grant file the server reads on every request and
   * `revoke` removes it, so revocation is observable the moment it happens.
   */
  readonly proxy?: CredentialProxyAdmin;
  readonly #instances = new Map<string, ComputerInstance>();
  /** The bot each computer belongs to, so `list()` can report a full reference. */
  readonly #botIds = new Map<string, string>();
  readonly #snapshots = new Map<
    string,
    {
      readonly snapshotId: string;
      readonly instance: ComputerInstance;
      readonly size: number;
      readonly checksum: string;
    }
  >();
  readonly #pages = new Map<string, EmulatedComputerPage>();
  readonly #actions = new Map<string, BrowserActionScript>();
  readonly #executedCommands: ComputerExecRequest[] = [];
  readonly #browserActions: RecordedBrowserAction[] = [];
  readonly #inputs: ComputerInput[] = [];
  #nextGeneration = 1;

  constructor(options: ComputerEmulatorOptions = {}) {
    this.#home = options.home ?? DEFAULT_COMPUTER_HOME;
    this.#now = options.now ?? (() => 0);
    this.#proxyOptions = options.proxy;

    if (!this.#home.startsWith("/") || this.#home === "/") {
      throw new RangeError(
        `home must be an absolute path below the root, received "${this.#home}"`,
      );
    }

    if (options.proxy !== undefined) {
      this.proxy = {
        grant: (computer, grant) => this.#grantProxy(computer, grant),
        revoke: (computer, runId) => this.#revokeProxy(computer, runId),
        endpoint: (computer) => this.#proxyEndpoint(computer),
      };
    }
  }

  /**
   * Stops every proxy server this emulator started and removes its grant
   * directory. A test that configured a proxy calls this with the emulator; a
   * machine that is stopped or destroyed releases its proxy on its own, since
   * a parked machine's grants are as gone as a stopped sidecar's tmpfs.
   */
  async close(): Promise<void> {
    const computers = [...this.#proxies.keys()].map((computerId) => ({
      computerId,
      botId: this.#botIds.get(computerId) ?? "",
    }));

    await Promise.all(computers.map((computer) => this.#closeProxy(computer)));
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

  /** Park a computer without removing it; `ensure` starts it again. Idempotent. */
  async stop(computer: ComputerRef): Promise<ComputerStatus> {
    const instance = this.#instances.get(computer.computerId);

    if (instance !== undefined) {
      instance.state = "stopped";
    }

    // A parked machine's proxy parks with it, exactly as the Docker sidecar
    // does: its grants were memory, and memory does not survive a stop.
    await this.#closeProxy(computer);

    return this.#status(computer);
  }

  /** Every machine this emulator still holds, in creation order. */
  async list(): Promise<readonly ComputerStatus[]> {
    return [...this.#instances.keys()].map((computerId) =>
      this.#status({ computerId, botId: this.#botIds.get(computerId) ?? "" }),
    );
  }

  /** The offline emulator is always reachable and holds no credential. */
  async validate(): Promise<void> {
    // Nothing to dial and nothing to refuse: the emulator is always available.
  }

  async ensure(computer: ComputerRef): Promise<ComputerStatus> {
    this.#botIds.set(computer.computerId, computer.botId);
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
    const snapshotId = randomUUID();
    const key = computerSnapshotKey(computer, snapshotId);
    const archive = archiveInstance(instance);
    const checksum = createHash("sha256").update(archive).digest("hex");

    this.#snapshots.set(key, {
      snapshotId,
      instance: cloneInstance(instance),
      size: archive.byteLength,
      checksum,
    });

    return { snapshotId, key, size: archive.byteLength, checksum };
  }

  async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
    const saved = this.#snapshots.get(snapshot.key);

    // The id, the key, the length and the checksum must all name the same
    // stored snapshot: a hand-assembled or altered handle is refused rather
    // than silently resolving to whatever the key holds, and the refusal
    // happens before the machine is touched.
    if (
      saved === undefined ||
      snapshot.key !== computerSnapshotKey(computer, snapshot.snapshotId) ||
      saved.snapshotId !== snapshot.snapshotId ||
      saved.size !== snapshot.size ||
      saved.checksum !== snapshot.checksum
    ) {
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
    this.#botIds.set(computer.computerId, computer.botId);

    return this.#status(computer);
  }

  async destroy(computer: ComputerRef): Promise<void> {
    await this.#closeProxy(computer);
    this.#instances.delete(computer.computerId);
    this.#botIds.delete(computer.computerId);
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

  /** The proxy configuration, or a wiring defect if a proxy method ran without one. */
  #proxyConfiguration(): ComputerEmulatorProxyOptions {
    if (this.#proxyOptions === undefined) {
      throw new Error("the emulator was asked for a credential proxy without one configured");
    }

    return this.#proxyOptions;
  }

  /** One computer's proxy, started on first use; its URL is stable while it lives. */
  async #ensureProxy(computer: ComputerRef): Promise<EmulatedProxy> {
    const existing = this.#proxies.get(computer.computerId);

    if (existing !== undefined) {
      return existing;
    }

    const configuration = this.#proxyConfiguration();
    const grantDir = await mkdtemp(path.join(tmpdir(), "porkbot-emulator-proxy-"));
    const server = await createCredentialProxyServer({
      tokenSecret: configuration.tokenSecret,
      computer,
      grantDir,
      host: "127.0.0.1",
      port: 0,
      ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
      ...(configuration.nowSeconds === undefined ? {} : { nowSeconds: configuration.nowSeconds }),
    });
    const proxy: EmulatedProxy = { server, grantDir, runIds: new Set<string>() };
    this.#proxies.set(computer.computerId, proxy);

    return proxy;
  }

  async #closeProxy(computer: ComputerRef): Promise<void> {
    const proxy = this.#proxies.get(computer.computerId);

    if (proxy === undefined) {
      return;
    }

    this.#proxies.delete(computer.computerId);
    await proxy.server.close();
    await rm(proxy.grantDir, { recursive: true, force: true });
  }

  async #grantProxy(
    computer: ComputerRef,
    grant: ComputerProxyGrant,
  ): Promise<ComputerProxyEndpoint> {
    // The machine has to be running for its proxy to be reachable; a stopped
    // machine's sidecar is stopped with it.
    this.#running(computer);
    const proxy = await this.#ensureProxy(computer);

    await writeFile(
      path.join(proxy.grantDir, proxyGrantFileName(grant.runId)),
      serializeProxyGrant(grant),
    );
    proxy.runIds.add(grant.runId);

    return { url: proxy.server.url };
  }

  async #revokeProxy(computer: ComputerRef, runId: string): Promise<void> {
    const proxy = this.#proxies.get(computer.computerId);

    if (proxy === undefined) {
      // The proxy is gone, so the grant is gone: the revoke is already done.
      return;
    }

    await rm(path.join(proxy.grantDir, proxyGrantFileName(runId)), { force: true });
    proxy.runIds.delete(runId);
  }

  async #proxyEndpoint(computer: ComputerRef): Promise<ComputerProxyEndpoint | undefined> {
    const instance = this.#instances.get(computer.computerId);

    if (instance === undefined || instance.state !== "running") {
      return undefined;
    }

    return { url: (await this.#ensureProxy(computer)).server.url };
  }

  #createInstance(): ComputerInstance {
    const instance = cloneInstance({
      state: "running",
      generation: this.#nextGeneration,
      files: createFileSystem(this.#home),
      browser: { currentUrl: undefined, typed: new Map(), typedBuffer: "" },
    });
    this.#nextGeneration += 1;

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
    return createShellWorld({
      files: instance.files,
      cwd: this.#home,
      browser: (command) => this.#browserOutcome(instance, command),
    });
  }
}

/**
 * The bytes a snapshot captures: the home's files and the browser session,
 * serialized in a fixed order so the same state always answers the same
 * checksum. The machine's `state` and `generation` are deliberately outside the
 * archive — they describe the instance, not the agent's home, and a restore
 * brings the home back into a fresh running generation.
 */
function archiveInstance(instance: ComputerInstance): Buffer {
  const files = [...instance.files.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, node]) =>
      node.kind === "file"
        ? { path, kind: "file", content: Buffer.from(node.content).toString("base64") }
        : { path, kind: "dir" },
    );
  const typed = [...instance.browser.typed.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return Buffer.from(
    JSON.stringify({
      files,
      browser: {
        currentUrl: instance.browser.currentUrl ?? null,
        typed,
        typedBuffer: instance.browser.typedBuffer,
      },
    }),
    "utf8",
  );
}

function cloneInstance(source: ComputerInstance): ComputerInstance {
  return {
    state: source.state,
    generation: source.generation,
    files: cloneFileSystem(source.files),
    browser: {
      currentUrl: source.browser.currentUrl,
      typed: new Map(source.browser.typed),
      typedBuffer: source.browser.typedBuffer,
    },
  };
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

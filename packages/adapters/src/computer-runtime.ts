import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";

/**
 * The provider-neutral computer lifecycle (slices 7.2 and 7.3, PRD decisions 19
 * and 20).
 *
 * `ComputerProvider` names eight operations, and the way they compose — adopt a
 * running machine, start a parked one, create a missing one, wait bounded for
 * readiness, park idempotently, keep ids stable through snapshots, refuse a
 * foreign snapshot key — is the same whichever wire a provider speaks. This
 * module owns that composition once. A provider supplies a `ComputerRuntime`:
 * the small set of primitives only its own API can answer (find, list, create,
 * start, stop, remove, ready, exec, readHome, writeHome), and the classifier
 * that turns its refusals into the shared vocabulary. The Docker provider and
 * the cloud provider are then two runtimes over one lifecycle, not two copies
 * of one, which is what keeps "the computer is gone" and "a retry is
 * idempotent" single implementations.
 *
 * Everything here is provider-shaped and secret-free. A machine is addressed by
 * ids, commands cross as strings, and a credential never appears in an
 * interface: it lives inside the runtime's transport.
 */

/** A provider's live instance, as the shared lifecycle sees it. */
export interface ComputerMachine {
  /** The provider's identifier for the instance, echoed in every status. */
  readonly instanceId: string;
  readonly state: "running" | "stopped";
}

/** One listed machine: the reference it belongs to and its provider handle. */
export interface ComputerListedMachine {
  readonly computer: ComputerRef;
  readonly machine: ComputerMachine;
}

/**
 * The primitives one provider implements. Every method either succeeds or
 * throws a classified `ComputerProviderError`; a raw transport error escaping a
 * runtime is a bug on the provider's side, not a state the lifecycle may guess
 * about.
 *
 * `create` provisions a machine and begins its boot, but does not have to wait
 * for it; `start` makes a stopped machine run and is idempotent on a machine
 * that is already running or still booting. `ready` is the one bounded wait,
 * with the caller's budget. `writeHome` is called on a machine `create` just
 * produced, and may itself wait for readiness when the provider cannot receive
 * bytes before the machine answers.
 */
export interface ComputerRuntime {
  find(computer: ComputerRef): Promise<ComputerMachine | undefined>;
  /** Every machine the provider holds, tagged with the reference it belongs to. */
  list(): Promise<readonly ComputerListedMachine[]>;
  /** Anything a provider must prepare before a machine exists (an image, a network). */
  prepare(computer: ComputerRef): Promise<void>;
  create(computer: ComputerRef): Promise<ComputerMachine>;
  start(machine: ComputerMachine, computer: ComputerRef): Promise<ComputerMachine>;
  /**
   * Parks a running machine; its home survives for the next `start`. Answers
   * `undefined` when the machine left the provider while it was being parked,
   * so a retried stop stays idempotent instead of manufactured into an error.
   */
  stop(machine: ComputerMachine, computer: ComputerRef): Promise<ComputerMachine | undefined>;
  /** Removes a machine. Its home survives only in a snapshot. */
  remove(machine: ComputerMachine, computer: ComputerRef): Promise<void>;
  ready(
    machine: ComputerMachine,
    computer: ComputerRef,
    budgetMs: number,
  ): Promise<ComputerMachine>;
  exec(
    machine: ComputerMachine,
    computer: ComputerRef,
    request: ComputerExecRequest,
  ): Promise<ComputerExecResult>;
  /** Writes the home's archive to `destination`, creating no parent directories. */
  readHome(machine: ComputerMachine, computer: ComputerRef, destination: string): Promise<void>;
  /** Places the home from the archive at `source`; the archive's bytes are `byteLength`. */
  writeHome(
    machine: ComputerMachine,
    computer: ComputerRef,
    source: string,
    byteLength: number,
  ): Promise<void>;
}

export interface RuntimeComputerProviderOptions {
  readonly runtime: ComputerRuntime;
  /** Where home archives land; slice 7.5 moves this onto the storage seam. */
  readonly snapshotDirectory: string;
  /** How long `ensure` and `restore` wait for a machine to become ready, in milliseconds. */
  readonly bootTimeoutMs?: number | undefined;
}

/** The identity hash every provider scopes a snapshot by. */
export function computerIdentityHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** The scope a computer's snapshots live under; it never names the ids directly. */
export function snapshotScope(computer: ComputerRef): string {
  return computerIdentityHash(`snapshot\u0000${computer.botId}\u0000${computer.computerId}`);
}

/** A snapshot's key as both providers name it: `<scope>/<snapshotId>.tar`. */
export const computerSnapshotKeyPattern = /^([0-9a-f]{16})\/([0-9a-f-]{36})\.tar$/;

function statusOf(computer: ComputerRef, machine: ComputerMachine): ComputerStatus {
  return { computer: { ...computer }, state: machine.state, instanceId: machine.instanceId };
}

const gone = (computer: ComputerRef): ComputerStatus => ({
  computer: { ...computer },
  state: "gone",
});

/** Resolves a snapshot key to a file inside the snapshot directory, or refuses. */
function snapshotFile(
  directory: string,
  computer: ComputerRef,
  snapshot: ComputerSnapshot,
): string | undefined {
  const match = computerSnapshotKeyPattern.exec(snapshot.key);

  // The key is scope-checked against the computer before a path is built, so a
  // hand-assembled key cannot point at another machine's archive or escape the
  // snapshot directory.
  if (
    match === null ||
    snapshot.key !== `${snapshotScope(computer)}/${snapshot.snapshotId}.tar` ||
    snapshot.snapshotId.trim() === ""
  ) {
    return undefined;
  }

  return path.join(directory, match[1] ?? "", `${match[2] ?? ""}.tar`);
}

/**
 * Builds the `ComputerProvider` seam over one runtime. The returned provider is
 * deliberately thin: every decision it makes is one the provider plan documents
 * as shared (idempotent ensure and stop, bounded readiness, `gone` answers,
 * scoped snapshots), and every provider-specific act is a runtime call.
 */
export function createRuntimeComputerProvider(
  options: RuntimeComputerProviderOptions,
): ComputerProvider {
  const runtime = options.runtime;
  const snapshotDirectory = options.snapshotDirectory;
  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;

  return {
    async ensure(computer: ComputerRef): Promise<ComputerStatus> {
      const existing = await runtime.find(computer);

      if (existing !== undefined && existing.state === "running") {
        return statusOf(computer, await runtime.ready(existing, computer, bootTimeoutMs));
      }

      if (existing === undefined) {
        await runtime.prepare(computer);
      }

      const created = existing ?? (await runtime.create(computer));
      const started = await runtime.start(created, computer);

      return statusOf(computer, await runtime.ready(started, computer, bootTimeoutMs));
    },

    async status(computer: ComputerRef): Promise<ComputerStatus> {
      const machine = await runtime.find(computer);

      return machine === undefined ? gone(computer) : statusOf(computer, machine);
    },

    async stop(computer: ComputerRef): Promise<ComputerStatus> {
      const machine = await runtime.find(computer);

      if (machine === undefined) {
        return gone(computer);
      }

      if (machine.state !== "running") {
        return statusOf(computer, machine);
      }

      const parked = await runtime.stop(machine, computer);

      return parked === undefined ? gone(computer) : statusOf(computer, parked);
    },

    async list(): Promise<readonly ComputerStatus[]> {
      const listed = await runtime.list();

      return listed.map((entry) => statusOf(entry.computer, entry.machine));
    },

    async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new RangeError(
          `timeoutMs must be a positive integer of milliseconds, received ${String(request.timeoutMs)}`,
        );
      }

      const machine = await runtime.find(request.computer);

      if (machine === undefined || machine.state !== "running") {
        throw new ComputerProviderError(
          "gone",
          `no running computer ${request.computer.computerId} is provisioned; call ensure first`,
        );
      }

      return runtime.exec(machine, request.computer, request);
    },

    async snapshot(computer: ComputerRef): Promise<ComputerSnapshot> {
      const machine = await runtime.find(computer);

      if (machine === undefined) {
        throw new ComputerProviderError(
          "gone",
          `no computer ${computer.computerId} is provisioned`,
        );
      }

      const scope = snapshotScope(computer);
      const snapshotId = randomUUID();
      const directory = path.join(snapshotDirectory, scope);
      const file = path.join(directory, `${snapshotId}.tar`);

      await mkdir(directory, { recursive: true });
      await runtime.readHome(machine, computer, file);

      return { snapshotId, key: `${scope}/${snapshotId}.tar` };
    },

    async restore(computer: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> {
      const file = snapshotFile(snapshotDirectory, computer, snapshot);

      if (file === undefined) {
        throw new ComputerProviderError(
          "not_found",
          `no snapshot is stored under "${snapshot.key}" for this computer`,
        );
      }

      const archive = await stat(file).catch(() => undefined);

      if (archive === undefined || !archive.isFile()) {
        throw new ComputerProviderError(
          "not_found",
          `no snapshot archive exists at "${snapshot.key}"`,
        );
      }

      await runtime.prepare(computer);

      // Restore means the snapshot wins: the old machine is replaced, so
      // nothing the snapshot does not carry can survive into the restored one,
      // and then the archive is placed before the machine is asked to run.
      const existing = await runtime.find(computer);

      if (existing !== undefined) {
        await runtime.remove(existing, computer);
      }

      const machine = await runtime.create(computer);

      try {
        await runtime.writeHome(machine, computer, file, archive.size);
        await runtime.start(machine, computer);
      } catch (error) {
        // A restore that failed after the old machine was replaced leaves no
        // half-built machine behind: the fresh one is removed, so the next
        // attempt starts from gone rather than from an empty home.
        await runtime.remove(machine, computer).catch(() => undefined);
        throw error;
      }

      return statusOf(computer, await runtime.ready(machine, computer, bootTimeoutMs));
    },

    async destroy(computer: ComputerRef): Promise<void> {
      const machine = await runtime.find(computer);

      if (machine === undefined) {
        return;
      }

      await runtime.remove(machine, computer);
    },
  };
}

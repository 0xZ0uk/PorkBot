export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const INITIAL_RUN_STATUS: RunStatus = "queued";

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "failed", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class IllegalTransition extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;

  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal run transition: ${from} -> ${to}`);
    this.name = "IllegalTransition";
    this.from = from;
    this.to = to;
  }
}

export type TransitionResult =
  | { readonly ok: true; readonly status: RunStatus }
  | { readonly ok: false; readonly error: IllegalTransition };

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function transition(from: RunStatus, to: RunStatus): TransitionResult {
  if (!canTransition(from, to)) {
    return { ok: false, error: new IllegalTransition(from, to) };
  }

  return { ok: true, status: to };
}

export function assertTransition(from: RunStatus, to: RunStatus): RunStatus {
  const result = transition(from, to);
  if (!result.ok) {
    throw result.error;
  }

  return result.status;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isActiveStatus(status: RunStatus): boolean {
  return !isTerminalStatus(status);
}

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

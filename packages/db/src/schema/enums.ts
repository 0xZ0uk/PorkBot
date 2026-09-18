import { APPROVAL_STATUSES, MEMORY_KINDS, MEMORY_WRITE_ORIGINS, RUN_STATUSES } from "@porkbot/core";
import { pgEnum } from "drizzle-orm/pg-core";

/**
 * The typed-status rule, in one module.
 *
 * PRD decision 6 fixes the reference implementation's free-string status
 * columns: a status the database accepts must be a status the domain knows, and
 * garbage is rejected at the write, not hoped away at the read. Each closed set
 * below is a Postgres enum, so the database is the authority.
 *
 * Run status is not restated here: `@porkbot/core` owns the run state machine
 * and its transition map, and the enum is built from `RUN_STATUSES` so the
 * database and `transition()` cannot drift. The other three sets are the
 * lifecycle vocabularies this domain writes — task, attempt and external effect
 * — and they live here until a slice gives each its own state machine.
 *
 * Sets that grow over time (event types, effect kinds, run triggers) are
 * deliberately not enums; they are text, with a check constraint where the
 * current vocabulary is closed enough to enumerate.
 */
export const runStatus = pgEnum("run_status", RUN_STATUSES);

export const taskStatus = pgEnum("task_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const attemptStatus = pgEnum("attempt_status", [
  "running",
  "completed",
  "failed",
  "abandoned",
]);

export const effectStatus = pgEnum("effect_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Message authorship. The same closed pair the event reducer renders — a run
 * produces assistant messages, an operator or a steering command produces user
 * messages — so a row cannot claim a role the wire vocabulary cannot express.
 */
export const messageRole = pgEnum("message_role", ["user", "assistant"]);

/**
 * The approval lifecycle, built from `@porkbot/core`'s vocabulary for the same
 * reason run status is: the gate's domain and the database must not disagree
 * about what "pending" means or about which decisions exist. A resolved row is
 * `approved` or `denied` by an operator of record, or `timed_out` by the
 * deadline with no operator at all.
 */
export const approvalStatus = pgEnum("approval_status", APPROVAL_STATUSES);

/**
 * The memory document's closed kind and write-path vocabularies, built from
 * `@porkbot/core`'s constants for the same reason run status is: the domain
 * rules, the database and (through the seam) the index provider must not
 * disagree about what a "preference" is or where a write came from.
 */
export const memoryKind = pgEnum("memory_kind", MEMORY_KINDS);
export const memoryWriteOrigin = pgEnum("memory_write_origin", MEMORY_WRITE_ORIGINS);

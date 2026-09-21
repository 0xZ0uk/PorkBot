import type { Approval, Bot, BotSection, Thread } from "@porkbot/contracts";
import type { StateChipState } from "@porkbot/ui";
import { latestActivity } from "./bots.ts";
import type { BotsTransport } from "./bots.ts";
import { stateFromRoster } from "./shell/bot-state.ts";

/**
 * The roster (slice 13.6): every bot as one row the rail, the home screen and
 * the archived group all read from. A row carries the bot's identity, its
 * name, its role, the state chip, the latest activity as a one-line summary
 * and when that happened.
 *
 * The state is what the roster can stand behind with the reads it has: the
 * operator's pending approvals put a bot on "waiting", and every other bot is
 * idle. The run-derived words — working, stuck, failed, stopped — render from
 * the same chip once a run read exists; the vocabulary is the shell's either
 * way, so a row and the thread header cannot disagree about what a word means.
 */

/** The latest activity, as a summary and the instant it happened. */
export interface RosterActivity {
  /** One line naming what last happened, e.g. "Waiting on web_fetch". */
  readonly summary: string;
  /** When it happened, or null when the bot has no activity yet. */
  readonly at: string | null;
}

export interface RosterEntry {
  readonly bot: Bot;
  /** A data URL for the stored avatar, or null for the generated identity. */
  readonly avatarUrl: string | null;
  readonly state: StateChipState;
  /** The bot's pending approvals; the waiting chip's count. */
  readonly waiting: number;
  readonly activity: RosterActivity;
}

export interface Roster {
  readonly active: readonly RosterEntry[];
  readonly archived: readonly RosterEntry[];
  readonly sections: readonly BotSection[];
}

export const emptyRoster: Roster = { active: [], archived: [], sections: [] };

/** The reads the roster needs; the route supplies the rest of the transport. */
export type RosterTransport = Pick<
  BotsTransport,
  "listBots" | "listSections" | "listThreads" | "readAvatar"
>;

/**
 * The roster as the rail and the home screen read it, in one pass.
 *
 * The active list is the roster the operator is working in, so a failure there
 * is the shell's failure. The archived list and the sections are extras: a
 * failure degrades to "none" rather than emptying the rail over a scope the
 * operator is not looking at, and one bot's activity read that fails degrades
 * to an unknown instant rather than the whole list.
 */
export async function readRoster(
  transport: RosterTransport,
  approvals: readonly Approval[],
): Promise<Roster> {
  const activeBots = await transport.listBots("active");
  const [archivedBots, sections] = await Promise.all([
    orEmpty(() => transport.listBots("archived")),
    orEmpty(() => transport.listSections()),
  ]);
  const [active, archived] = await Promise.all([
    enrich(transport, activeBots, approvals),
    enrich(transport, archivedBots, approvals),
  ]);

  return { active, archived, sections };
}

async function orEmpty<T>(read: () => Promise<readonly T[]>): Promise<readonly T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

async function enrich(
  transport: RosterTransport,
  bots: readonly Bot[],
  approvals: readonly Approval[],
): Promise<readonly RosterEntry[]> {
  return Promise.all(
    bots.map(async (bot) => {
      const pending = approvals.filter((approval) => approval.botId === bot.id);
      const [threads, avatarUrl] = await Promise.all([
        readThreads(transport, bot.id),
        readAvatarUrl(transport, bot),
      ]);

      return rosterEntry(bot, { avatarUrl, threads, pending });
    }),
  );
}

/** `null` is a read that failed; the row says the instant is unknown. */
async function readThreads(
  transport: RosterTransport,
  botId: string,
): Promise<readonly Thread[] | null> {
  try {
    return await transport.listThreads(botId);
  } catch {
    return null;
  }
}

/** One bot's row, from the reads the roster already made. */
export function rosterEntry(
  bot: Bot,
  input: {
    readonly avatarUrl: string | null;
    readonly threads: readonly Thread[] | null;
    readonly pending: readonly Approval[];
  },
): RosterEntry {
  return {
    bot,
    avatarUrl: input.avatarUrl,
    state: stateFromRoster(input.pending.length),
    waiting: input.pending.length,
    activity: rosterActivity({
      pending: input.pending,
      lastActivityAt: input.threads === null ? undefined : latestActivity(input.threads),
    }),
  };
}

/**
 * The latest activity: a pending approval names the tool it is waiting on, a
 * bot with threads says when it was last active, and a bot with neither says
 * so rather than showing a timestamp it does not have. An undefined instant is
 * a read that failed: "no activity yet" would be a claim the roster cannot
 * stand behind, so the row says the activity is unavailable instead.
 */
export function rosterActivity(input: {
  readonly pending: readonly Approval[];
  readonly lastActivityAt: string | null | undefined;
}): RosterActivity {
  const waiting = input.pending[0];

  if (waiting !== undefined) {
    return {
      summary: `Waiting on ${waiting.tool}`,
      at: input.lastActivityAt ?? null,
    };
  }

  if (input.lastActivityAt === undefined) {
    return { summary: "Activity unavailable", at: null };
  }

  if (input.lastActivityAt !== null) {
    return { summary: "Last active", at: input.lastActivityAt };
  }

  return { summary: "No activity yet", at: null };
}

async function readAvatarUrl(transport: RosterTransport, bot: Bot): Promise<string | null> {
  if (bot.avatarKey === null) {
    return null;
  }

  try {
    const avatar = await transport.readAvatar(bot.id);
    return `data:${avatar.contentType};base64,${avatar.data}`;
  } catch {
    // A missing object is treated like no avatar so the generated identity
    // remains available while storage is repaired or an upload is retried.
    return null;
  }
}

export interface RosterGroup {
  readonly id: string;
  readonly name: string | null;
  readonly entries: readonly RosterEntry[];
}

/**
 * The home screen's groups: pinned first, then the operator's sections in
 * their stored order, then the bots no section holds. A pinned bot appears in
 * the pinned group only, so the list has one place for it; an empty section is
 * not a group, because a heading with nothing under it is chrome.
 */
export function groupRoster(
  entries: readonly RosterEntry[],
  sections: readonly BotSection[],
): readonly RosterGroup[] {
  const ordered = [...sections].sort((left, right) => left.position - right.position);
  const known = new Set(ordered.map((section) => section.id));
  const rest = entries.filter((entry) => !entry.bot.pinned);
  const groups: RosterGroup[] = [];
  const pinned = entries.filter((entry) => entry.bot.pinned);

  if (pinned.length > 0) {
    groups.push({ id: "pinned", name: "Pinned", entries: pinned });
  }

  for (const section of ordered) {
    const items = rest.filter((entry) => entry.bot.sectionId === section.id);

    if (items.length > 0) {
      groups.push({ id: section.id, name: section.name, entries: items });
    }
  }

  const unfiled = rest.filter(
    (entry) => entry.bot.sectionId === null || !known.has(entry.bot.sectionId),
  );

  if (unfiled.length > 0) {
    groups.push({ id: "unfiled", name: ordered.length === 0 ? null : "Unfiled", entries: unfiled });
  }

  return groups;
}

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const weekMs = 7 * dayMs;

/** A short "when" for a row: minutes and hours while they are the useful unit. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();

  if (!Number.isFinite(then)) {
    return "unknown";
  }

  const delta = now.getTime() - then;

  if (delta < minuteMs) {
    return "just now";
  }

  if (delta < hourMs) {
    return `${String(Math.floor(delta / minuteMs))}m ago`;
  }

  if (delta < dayMs) {
    return `${String(Math.floor(delta / hourMs))}h ago`;
  }

  if (delta < weekMs) {
    return `${String(Math.floor(delta / dayMs))}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(then));
}

/** The full local instant behind a relative time, for the row's title. */
export function absoluteTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

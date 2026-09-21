import type { Approval, Bot, BotSection, Thread } from "@porkbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { fakeBot, fakeThread } from "../test/fakes.ts";
import { groupRoster, readRoster, relativeTime, rosterActivity, rosterEntry } from "./roster.ts";
import type { RosterTransport } from "./roster.ts";

const now = new Date("2026-03-01T12:00:00.000Z");

function approval(botId: string, tool = "web_fetch", id = "approval-1"): Approval {
  return {
    id,
    botId,
    threadId: "thread-1",
    runId: "run-1",
    callId: "call-1",
    tool,
    arguments: {},
    status: "pending",
    expiresAt: "2026-03-01T12:05:00.000Z",
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };
}

function section(id: string, name: string, position: number): BotSection {
  return {
    id,
    name,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("relativeTime", () => {
  it("speaks in the unit that is useful", () => {
    expect(relativeTime("2026-03-01T11:59:45.000Z", now)).toBe("just now");
    expect(relativeTime("2026-03-01T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeTime("2026-03-01T09:00:00.000Z", now)).toBe("3h ago");
    expect(relativeTime("2026-02-27T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("falls back to the date once a week has passed", () => {
    const older = relativeTime("2026-02-01T12:00:00.000Z", now);

    expect(older).not.toContain("ago");
    expect(older).toContain("2026");
  });
});

describe("rosterEntry", () => {
  it("waits on the approval's tool and counts it", () => {
    const entry = rosterEntry(fakeBot("bot-1", "Ada"), {
      avatarUrl: null,
      threads: [fakeThread("thread-1", "bot-1")],
      pending: [approval("bot-1")],
    });

    expect(entry.state).toBe("waiting");
    expect(entry.waiting).toBe(1);
    expect(entry.activity).toEqual({
      summary: "Waiting on web_fetch",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("is idle with the last activity when nothing waits", () => {
    const threads: readonly Thread[] = [
      { ...fakeThread("thread-1", "bot-1"), updatedAt: "2026-02-28T12:00:00.000Z" },
    ];
    const entry = rosterEntry(fakeBot("bot-1", "Ada"), {
      avatarUrl: "data:image/png;base64,ZmFrZQ==",
      threads,
      pending: [],
    });

    expect(entry.state).toBe("idle");
    expect(entry.waiting).toBe(0);
    expect(entry.avatarUrl).toBe("data:image/png;base64,ZmFrZQ==");
    expect(entry.activity).toEqual({ summary: "Last active", at: "2026-02-28T12:00:00.000Z" });
  });

  it("says so when the bot has never been active", () => {
    expect(rosterActivity({ pending: [], lastActivityAt: null })).toEqual({
      summary: "No activity yet",
      at: null,
    });
  });
});

describe("groupRoster", () => {
  const ada = fakeBot("bot-1", "Ada");
  const ledger = { ...fakeBot("bot-2", "Ledger"), sectionId: "section-2" };
  const grace = { ...fakeBot("bot-3", "Grace"), pinned: true };
  const ember = { ...fakeBot("bot-4", "Ember"), sectionId: "section-1" };
  const entries = [ada, ledger, grace, ember].map((bot) =>
    rosterEntry(bot, { avatarUrl: null, threads: [], pending: [] }),
  );

  it("puts pinned first, then sections in order, then the unfiled bots", () => {
    const groups = groupRoster(entries, [
      section("section-2", "Research", 1),
      section("section-1", "Ops", 0),
      section("section-3", "Empty", 2),
    ]);

    expect(groups.map((group) => group.name)).toEqual(["Pinned", "Ops", "Research", "Unfiled"]);
    expect(groups[0]?.entries.map((entry) => entry.bot.name)).toEqual(["Grace"]);
    expect(groups[1]?.entries.map((entry) => entry.bot.name)).toEqual(["Ember"]);
    expect(groups[2]?.entries.map((entry) => entry.bot.name)).toEqual(["Ledger"]);
    expect(groups[3]?.entries.map((entry) => entry.bot.name)).toEqual(["Ada"]);
  });

  it("does not head an unfiled group when no sections exist", () => {
    const unfiled = entries.filter((entry) => !entry.bot.pinned && entry.bot.sectionId === null);
    const groups = groupRoster(unfiled, []);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBeNull();
    expect(groups[0]?.entries.map((entry) => entry.bot.name)).toEqual(["Ada"]);
  });
});

describe("readRoster", () => {
  it("reads both scopes, sections and one row per bot", async () => {
    const active: readonly Bot[] = [
      fakeBot("bot-1", "Ada"),
      { ...fakeBot("bot-2", "Ledger"), sectionId: "section-1" },
    ];
    const archived: readonly Bot[] = [
      { ...fakeBot("bot-3", "Grace"), archivedAt: "2026-02-01T00:00:00.000Z" },
    ];
    const transport: RosterTransport = {
      listBots: vi.fn(async (scope) => (scope === "active" ? active : archived)),
      listSections: vi.fn(async () => [section("section-1", "Research", 0)]),
      listThreads: vi.fn(async () => [
        { ...fakeThread("thread-1", "bot-1"), updatedAt: "2026-02-28T12:00:00.000Z" },
      ]),
      readAvatar: vi.fn(async () => ({ contentType: "image/png", data: "ZmFrZQ==" })),
    };
    const roster = await readRoster(transport, [approval("bot-2")]);

    expect(roster.sections).toHaveLength(1);
    expect(roster.active.map((entry) => entry.bot.name)).toEqual(["Ada", "Ledger"]);
    expect(roster.archived.map((entry) => entry.bot.name)).toEqual(["Grace"]);
    expect(roster.active[0]?.activity.summary).toBe("Last active");
    expect(roster.active[1]?.state).toBe("waiting");
    expect(transport.readAvatar).not.toHaveBeenCalled();
  });

  it("keeps the active roster when an extra scope fails, and marks a failed activity", async () => {
    const active = [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Ledger")];
    const transport: RosterTransport = {
      listBots: async (scope) => {
        if (scope === "archived") {
          throw new Error("unreachable");
        }

        return active;
      },
      listSections: async () => {
        throw new Error("unreachable");
      },
      listThreads: async (botId) => {
        if (botId === "bot-2") {
          throw new Error("unreachable");
        }

        return [];
      },
      readAvatar: async () => ({ contentType: "image/png", data: "ZmFrZQ==" }),
    };
    const roster = await readRoster(transport, []);

    expect(roster.active.map((entry) => entry.bot.name)).toEqual(["Ada", "Ledger"]);
    expect(roster.archived).toEqual([]);
    expect(roster.sections).toEqual([]);
    expect(roster.active[0]?.activity).toEqual({ summary: "No activity yet", at: null });
    expect(roster.active[1]?.activity).toEqual({ summary: "Activity unavailable", at: null });
  });

  it("reads an uploaded avatar as a data URL and treats a failed read as none", async () => {
    const withAvatar = { ...fakeBot("bot-1", "Ada"), avatarKey: "avatars/bot-1" };
    const brokenAvatar = { ...fakeBot("bot-2", "Ledger"), avatarKey: "avatars/bot-2" };
    const transport: RosterTransport = {
      listBots: async (scope) => (scope === "active" ? [withAvatar, brokenAvatar] : []),
      listSections: async () => [],
      listThreads: async () => [],
      readAvatar: async (botId) => {
        if (botId === "bot-2") {
          throw new Error("missing object");
        }

        return { contentType: "image/png", data: "ZmFrZQ==" };
      },
    };
    const roster = await readRoster(transport, []);

    expect(roster.active[0]?.avatarUrl).toBe("data:image/png;base64,ZmFrZQ==");
    expect(roster.active[1]?.avatarUrl).toBeNull();
  });
});

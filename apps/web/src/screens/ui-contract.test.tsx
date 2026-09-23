// @vitest-environment jsdom
import { uiHooks, uiHookNames, uiHooksByScreen } from "@porkbot/testkit";
import type { UiHookName, UiHookScreen } from "@porkbot/testkit";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { Bot } from "@porkbot/contracts";
import { fakeBot, fakeMemoryDocument, fakeMemoryRevision } from "../../test/fakes.ts";
import { HomeScreen } from "./home.tsx";
import type { Roster, RosterEntry } from "../roster.ts";
import { ComposerScreen } from "./composer.tsx";
import type { ComposerState } from "../composer.ts";
import { ThreadConsoleScreen } from "./thread-console.tsx";
import type { ThreadConsoleState } from "../console.ts";
import { ComputerScreen } from "./computer.tsx";
import type { ComputerState } from "../computer.ts";
import { MemoryScreen } from "./memory.tsx";
import type { MemoryState } from "../memory.ts";
import { ConnectionsScreen } from "./connections.tsx";
import type { ConnectionsState } from "../connections.ts";
import { McpScreen } from "./mcp.tsx";
import type { McpState } from "../mcp.ts";
import { UsageScreen } from "./usage.tsx";
import { ApprovalsScreen } from "./approvals.tsx";
import type { Approval } from "@porkbot/contracts";
import { SettingsScreen } from "./settings.tsx";
import { Workspace } from "../shell/workspace.tsx";
import type { SettingsScreenProps } from "./settings.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bot: Bot = fakeBot("bot-1", "Ada");

function rosterEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    bot,
    avatarUrl: null,
    state: "idle",
    waiting: 0,
    activity: { summary: "Waiting on web_fetch", at: "2026-01-01T09:00:00.000Z" },
    ...overrides,
  };
}

const noop = () => {};
const never = (): never => {
  throw new Error("not exercised by this conformance test");
};

let root: Root | undefined;

/**
 * Screens render the register's links, which read a router from context; the
 * mount wraps each element in a throwaway router so a screen can be asserted
 * in isolation the way its route would present it.
 */
function withRouter(element: ReactElement): ReactElement {
  const rootRoute = createRootRoute({ component: () => element });
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultPreload: false,
  });
  return <RouterProvider router={router} />;
}

async function mount(element: React.ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(withRouter(element));
  });
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  root = undefined;
}

function present(name: UiHookName): boolean {
  return document.body.querySelector(uiHooks[name]) !== null;
}

/** The states a screen passes through on its way to showing its hooks. */
interface HookState {
  readonly mount: () => Promise<void>;
  readonly prepare?: () => Promise<void>;
  readonly hooks: readonly UiHookName[];
}

const cases: Record<UiHookScreen, readonly HookState[]> = {
  home: [
    {
      mount: async () => {
        const roster: Roster = { active: [rosterEntry()], archived: [], sections: [] };
        await mount(
          <HomeScreen
            roster={roster}
            failed={false}
            onRetry={noop}
            pendingBotId={null}
            error={null}
            onCreate={noop}
            onNewThread={noop}
            onArchive={async () => {}}
            onRestore={async () => {}}
            onPin={noop}
          />,
        );
      },
      hooks: ["rosterCard"],
    },
    {
      mount: async () => {
        const roster: Roster = { active: [], archived: [], sections: [] };
        await mount(
          <HomeScreen
            roster={roster}
            failed={false}
            onRetry={noop}
            pendingBotId={null}
            error={null}
            onCreate={noop}
            onNewThread={noop}
            onArchive={async () => {}}
            onRestore={async () => {}}
            onPin={noop}
          />,
        );
      },
      hooks: ["rosterEmpty"],
    },
  ],
  composer: [
    {
      mount: async () => {
        const state: ComposerState = {
          text: "",
          files: [
            {
              key: "up",
              filename: "up.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "uploading",
              progress: 0.5,
              detail: null,
              attachmentId: null,
            },
            {
              key: "ok",
              filename: "ok.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "ready",
              progress: 0,
              detail: null,
              attachmentId: "attachment-1",
            },
            {
              key: "bad",
              filename: "bad.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "invalid",
              progress: 0,
              attachmentId: null,
              detail: "Too large — the limit is 8 MB.",
            },
            {
              key: "failed",
              filename: "failed.txt",
              contentType: "text/plain",
              sizeBytes: 10,
              status: "failed",
              progress: 0,
              attachmentId: null,
              detail: "Upload failed; retry it or remove it.",
            },
          ],
          sending: false,
          canSend: false,
          error: null,
          dragActive: false,
        };
        await mount(
          <ComposerScreen
            state={state}
            botName="Ada"
            onText={noop}
            onFiles={noop}
            onRemoveFile={noop}
            onRetryFile={noop}
            onSend={noop}
            onDragActive={noop}
          />,
        );
      },
      hooks: [
        "composer",
        "composerShell",
        "composerTextarea",
        "composerFileInput",
        "composerFile",
        "composerFileReady",
        "composerFileFailed",
        "composerFileFailedMark",
      ],
    },
  ],
  console: [
    {
      mount: async () => {
        const state: ThreadConsoleState = {
          threadId: "thread-1",
          status: "ready",
          entries: [
            {
              kind: "message",
              id: "message-0",
              role: "user",
              text: "do it",
              createdAt: "2026-01-01T09:00:00.000Z",
              attachments: [
                {
                  type: "file",
                  attachmentId: "attachment-1",
                  filename: "notes.txt",
                  contentType: "text/plain",
                  sizeBytes: 2048,
                },
              ],
              streaming: false,
            },
            {
              kind: "tool",
              id: "tool:run-1:call-1",
              runId: "run-1",
              call: {
                callId: "call-1",
                tool: "shell",
                arguments: { command: "ls" },
                status: "completed",
                durationMs: 120,
                result: {
                  stdout: "all of it",
                  artifact: {
                    id: "01900000-0000-7000-8000-00000000a1f0",
                    filename: "summary.md",
                    sizeBytes: 2048,
                  },
                },
                resultArtifact: { kind: "tool_call", callId: "call-1", bytes: 2048 },
              },
            },
            {
              kind: "tool",
              id: "tool:run-1:call-2",
              runId: "run-1",
              call: {
                callId: "call-2",
                tool: "shell",
                arguments: {},
                status: "failed",
                durationMs: 12,
                error: 'tool "rm" failed (timed_out): no answer',
              },
            },
            {
              kind: "run",
              id: "run-1",
              runId: "run-1",
              run: {
                runId: "run-1",
                status: "completed",
                toolCalls: [
                  {
                    callId: "call-1",
                    tool: "shell",
                    arguments: { command: "ls" },
                    status: "completed",
                    durationMs: 120,
                  },
                ],
              },
              outcome: [{ kind: "done", text: "shell — ls" }],
            },
          ],
          refusal: null,
          connection: "live",
          liveness: {
            state: "waiting",
            tool: "shell",
            heartbeatLagMs: 3000,
            sinceProgressMs: 4000,
          },
          livenessStale: false,
          activeRunId: null,
          stopping: false,
          stopError: null,
        };
        await mount(
          <ThreadConsoleScreen
            botId="bot-1"
            state={state}
            bot={bot}
            onRetry={noop}
            onApprovalDecision={async () => {
              throw new Error("not exercised by this conformance test");
            }}
          />,
        );
      },
      hooks: [
        "transcript",
        "transcriptEntry",
        "toolCall",
        "toolCallName",
        "toolCallNameMark",
        "toolCallStatus",
        "toolCallDuration",
        "toolCallArtifact",
        "toolCallDownload",
        "toolCallDetails",
        "toolCallFailed",
        "runCard",
        "runCardTitle",
        "runCardLine",
        "liveStripStep",
        "messageAttachment",
      ],
    },
  ],
  computer: [
    {
      mount: async () => {
        const state: ComputerState = {
          status: "ready",
          refusal: null,
          bot,
          providers: {
            defaultKind: "offline",
            providers: [
              { kind: "offline", available: true, failure: null },
              { kind: "docker", available: true, failure: null },
              { kind: "default", available: false, failure: "not_found" },
            ],
          },
          computer: { assigned: true, state: "running" },
          files: { path: "/", preview: null, entries: [], pending: false, refusal: null },
          snapshots: [],
          candidate: null,
          pending: null,
          notice: null,
          terminal: {
            pending: false,
            entries: [
              {
                command: "echo hi",
                stdout: "hi",
                stderr: "",
                exitCode: 0,
                truncated: false,
              },
            ],
          },
        };
        await mount(
          <ComputerScreen
            state={state}
            onReload={noop}
            onChoose={noop}
            onCancel={noop}
            onConfirm={async () => {}}
            onSnapshot={async () => {}}
            onRestore={async () => {}}
            onLifecycle={async () => {}}
            onRun={async () => {}}
            onOpenDirectory={async () => {}}
            onOpenFile={async () => {}}
            onOpenParent={async () => {}}
          />,
        );
      },
      prepare: async () => {
        // The provider sheet lives in a portal; the terminal sits behind its tab.
        const buttons = [...document.body.querySelectorAll("button")];
        const change = buttons.find((b) => b.textContent === "Change");
        if (change !== undefined) {
          await act(async () => {
            change.click();
          });
        }
        const terminalTab = buttons.find((b) => b.textContent === "Terminal");
        if (terminalTab !== undefined) {
          await act(async () => {
            terminalTab.click();
          });
        }
      },
      hooks: [
        "computerViewState",
        "computerViewStateMark",
        "terminal",
        "terminalStdout",
        "providerList",
        "providerOption",
      ],
    },
  ],
  memory: [
    {
      mount: async () => {
        const state: MemoryState = {
          botId: "bot-1",
          status: "ready",
          refusal: null,
          scope: "active",
          documents: [
            fakeMemoryDocument({ documentId: "doc-1", title: "Release note" }),
            fakeMemoryDocument({
              documentId: "doc-2",
              title: "Gone",
              deletedAt: "2026-01-02T09:00:00.000Z",
            }),
          ],
          history: {
            "doc-1": {
              status: "ready",
              revisions: [fakeMemoryRevision({ documentId: "doc-1", revision: 1 })],
            },
          },
          openHistory: ["doc-1"],
          notice: null,
          pendingDocumentId: null,
        };
        await mount(
          <MemoryScreen
            state={state}
            onScope={noop}
            onRetry={noop}
            onToggleHistory={noop}
            onSave={async () => true}
            onRemove={async () => true}
            onRestore={async () => true}
          />,
        );
      },
      prepare: async () => {
        const buttons = [...document.body.querySelectorAll("button")];
        const edit = buttons.find((b) => b.textContent === "Edit");
        if (edit !== undefined) {
          await act(async () => {
            edit.click();
          });
        }
      },
      hooks: [
        "memoryDocument",
        "memoryForm",
        "memoryFormMark",
        "memoryTimelineEntry",
        "memoryRemoved",
        "memoryRemovedDoc",
      ],
    },
  ],
  connections: [
    {
      mount: async () => {
        const state: ConnectionsState = {
          status: "ready",
          refusal: null,
          connections: [
            {
              id: "conn-1",
              label: "Local models",
              baseUrl: "http://127.0.0.1:8080/v1",
              credentialName: "offline-model-emulator",
              credentialMaskedValue: "offline",
              defaultModel: "porkbot-e2e",
              isDefault: true,
              lastUsedAt: null,
              createdAt: "2026-01-01T09:00:00.000Z",
              updatedAt: "2026-01-01T09:00:00.000Z",
            },
          ],
          credentials: [],
          bots: [],
          probes: {},
          notice: null,
          pending: null,
        };
        await mount(
          <ConnectionsScreen
            state={state}
            onReload={noop}
            onProbe={async () => {}}
            onSetDefault={async () => {}}
            onDisconnect={async () => {}}
            onRevoke={async () => {}}
            onCreate={async () => true}
            onSetBotConnection={async () => {}}
          />,
        );
      },
      hooks: ["connectionRow", "connectionCard"],
    },
  ],
  mcp: [
    {
      mount: async () => {
        const state: McpState = {
          status: "ready",
          refusal: null,
          servers: [
            {
              id: "01900000-0000-7000-8000-0000000000f1",
              name: "Offline MCP",
              url: "http://127.0.0.1:8123/mcp",
              auth: "none",
              status: "ready",
              lastError: null,
              createdAt: "2026-01-01T09:00:00.000Z",
              updatedAt: "2026-01-01T09:00:00.000Z",
              toolCount: 1,
            },
          ],
          selected: {
            id: "01900000-0000-7000-8000-0000000000f1",
            name: "Offline MCP",
            url: "http://127.0.0.1:8123/mcp",
            auth: "none",
            status: "ready",
            lastError: null,
            createdAt: "2026-01-01T09:00:00.000Z",
            updatedAt: "2026-01-01T09:00:00.000Z",
            tools: [{ name: "lookup", description: "Looks things up", parameters: {} }],
          },
          grants: [
            {
              botId: "bot-1",
              revokedAt: null,
            },
          ],
          bots: [bot],
          pending: null,
          notice: null,
          consent: null,
        };
        await mount(
          <McpScreen
            state={state}
            onReload={noop}
            onOpen={noop}
            onClose={noop}
            onInstall={async () => true}
            onRemove={async () => {}}
            onGrant={async () => {}}
            onRevokeGrant={async () => {}}
            onRecheck={noop}
          />,
        );
      },
      hooks: ["connectionKey"],
    },
  ],
  usage: [
    {
      mount: async () => {
        await mount(
          <UsageScreen
            usage={{
              botId: "bot-1",
              total: {
                inputTokens: 1200,
                outputTokens: 200,
                reported: 2,
                unreported: 1,
              },
              periods: [
                {
                  startsAt: "2026-01-01T00:00:00.000Z",
                  inputTokens: 1200,
                  outputTokens: 200,
                  reported: 2,
                  unreported: 1,
                },
              ],
            }}
          />,
        );
      },
      hooks: ["usageStat"],
    },
  ],
  approvals: [
    {
      mount: async () => {
        const approvals: Approval[] = [
          {
            id: "approval-1",
            botId: "bot-1",
            threadId: "thread-1",
            runId: "run-1",
            callId: "call-1",
            tool: "gmail.send",
            arguments: { command: "echo offline" },
            status: "pending",
            decidedBy: null,
            reason: "Send one email",
            expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
            decidedAt: null,
          },
          {
            id: "approval-2",
            botId: "bot-1",
            threadId: "thread-1",
            runId: "run-2",
            callId: "call-2",
            tool: "echo",
            arguments: { command: "echo done" },
            status: "approved",
            decidedBy: "user-1",
            reason: null,
            expiresAt: "2026-01-01T09:05:00.000Z",
            decidedAt: "2026-01-01T09:01:00.000Z",
          },
          {
            id: "approval-3",
            botId: "bot-1",
            threadId: "thread-1",
            runId: "run-3",
            callId: "call-3",
            tool: "echo",
            arguments: { command: "echo late" },
            status: "timed_out",
            decidedBy: null,
            reason: null,
            expiresAt: "2026-01-01T09:05:00.000Z",
            decidedAt: "2026-01-01T09:06:00.000Z",
          },
        ];
        await mount(<ApprovalsScreen approvals={approvals} bots={[bot]} onDecision={never} />);
      },
      hooks: [
        "approvalTitle",
        "approvalConsequence",
        "approvalTarget",
        "approvalDecision",
        "approvalStatePending",
        "approvalStateApproved",
        "approvalStateTimedOut",
        "approvalsWaiting",
        "approvalsHistory",
      ],
    },
  ],
  workspace: [
    {
      mount: async () => {
        await mount(
          <Workspace
            roster={{ active: [], archived: [], sections: [] }}
            pendingApprovals={[]}
            onSignOut={noop}
          >
            <p>pane content</p>
          </Workspace>,
        );
      },
      hooks: ["shellPane"],
    },
  ],
  settings: [
    {
      mount: async () => {
        const sections: SettingsScreenProps["sections"] = [
          { id: "models", label: "Models", content: null },
          { id: "mcp", label: "MCP", content: null },
          { id: "secrets", label: "Secrets", content: null },
          { id: "notifications", label: "Notifications", content: null },
          { id: "usage", label: "Usage", content: null },
          { id: "account", label: "Account", content: null },
        ];
        await mount(<SettingsScreen sections={sections} />);
      },
      hooks: ["settingsSection", "settingsMode"],
    },
  ],
};

describe("the UI hook contract", () => {
  for (const screen of Object.keys(cases) as UiHookScreen[]) {
    for (const [index, state] of cases[screen].entries()) {
      it(`renders the ${screen} hooks — state ${String(index + 1)}`, async () => {
        await state.mount();
        await state.prepare?.();

        for (const hook of state.hooks) {
          expect(present(hook), `${hook} (${uiHooks[hook]})`).toBe(true);
        }

        await unmount();
      });
    }
  }

  it("claims every hook exactly once, screen by screen", () => {
    const claimed = Object.values(cases)
      .flat()
      .flatMap((state) => [...state.hooks])
      .sort();
    const expected = [...uiHookNames].sort();
    expect(claimed).toEqual(expected);

    for (const screen of Object.keys(cases) as UiHookScreen[]) {
      const perScreen = cases[screen].flatMap((state) => [...state.hooks]).sort();
      expect(perScreen, screen).toEqual([...uiHooksByScreen[screen]].sort());
    }
  });
});

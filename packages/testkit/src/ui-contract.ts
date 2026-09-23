/**
 * The UI hook contract: every selector the e2e suites drive the app by,
 * named once. The browser specs and the unit-tier conformance test import
 * this record, so a restyle that renames a hook fails `unit` in seconds
 * instead of the e2e tier in a quarter of an hour.
 *
 * Rules for new hooks: `data-*` for state (twMerge cannot eat an attribute),
 * a role or label query for controls, and a class only where a stylesheet
 * hook is unavoidable (then declare it with `@utility` in
 * `apps/web/src/globals.css` so lint sees it). A press is mousedown then
 * click — never a bare `click()` — and a visually hidden input is pressed
 * through `element.click()`.
 */
export const uiHooks = {
  // Roster and shell
  rosterCard: "[data-roster-card]",
  rosterEmpty: "[data-empty]",
  shellPane: "[data-shell-pane]",

  // Composer
  composer: "[data-composer]",
  composerShell: ".composer",
  composerTextarea: ".composer textarea",
  composerFileInput: "[data-composer] input[type='file']",
  composerFile: "[data-composer-file]",
  composerFileReady: ".composer-file-ready",
  composerFileFailed: "[data-composer-file][data-status='failed']",
  composerFileFailedMark: ".composer-file-failed",
  messageAttachment: "a.message-attachment",

  // Thread console
  transcript: ".transcript",
  transcriptEntry: "[data-transcript-entry]",
  toolCall: ".tool-call",
  toolCallName: "[data-tool-call-name]",
  toolCallNameMark: ".tool-call-name",
  toolCallStatus: ".tool-call-status",
  toolCallDuration: ".tool-call-duration",
  toolCallArtifact: "a.tool-call-artifact",
  toolCallDownload: "a.tool-call-download",
  toolCallDetails: "details.tool-call-details",
  toolCallFailed: ".tool-call-failed",
  runCard: ".run-card",
  runCardTitle: "[data-run-card-title]",
  runCardLine: ".run-card-line",
  liveStripStep: "[data-live-strip-step]",

  // Computer
  computerViewState: "[data-computer-view-state]",
  computerViewStateMark: ".computer-view-state",
  terminal: ".terminal",
  terminalStdout: "[data-terminal-stdout]",
  providerList: ".provider-list",
  providerOption: ".provider-option",

  // Memory
  memoryDocument: "[data-memory-document]",
  memoryForm: "[data-memory-form]",
  memoryFormMark: "form.memory-form",
  memoryTimelineEntry: "[data-memory-timeline-entry]",
  memoryRemoved: "[data-removed]",
  memoryRemovedDoc: ".memory-document--removed",

  // Connections
  connectionRow: "[data-connection-row]",
  connectionCard: ".connection",
  connectionKey: ".connection-key",

  // Usage
  usageStat: "[data-usage-stat]",

  // Approvals
  approvalTitle: "[data-approval-title]",
  approvalConsequence: "[data-approval-consequence]",
  approvalTarget: "[data-approval-target]",
  approvalDecision: "[data-approval-decision]",
  approvalStatePending: "[data-approval-state='pending']",
  approvalStateApproved: "[data-approval-state='approved']",
  approvalStateTimedOut: "[data-approval-state='timed_out']",
  approvalsWaiting: "#approvals-waiting",
  approvalsHistory: "#approvals-history",

  // Settings
  settingsSection: "[data-settings-section]",
  settingsMode: "[data-settings-mode]",
} as const;

export type UiHookName = keyof typeof uiHooks;

export const uiHookNames = Object.keys(uiHooks) as UiHookName[];

/** The screen that must render each hook — the conformance test's table. */
export const uiHooksByScreen = {
  home: ["rosterCard", "rosterEmpty"],
  workspace: ["shellPane"],
  composer: [
    "composer",
    "composerShell",
    "composerTextarea",
    "composerFileInput",
    "composerFile",
    "composerFileReady",
    "composerFileFailed",
    "composerFileFailedMark",
  ],
  console: [
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
  computer: [
    "computerViewState",
    "computerViewStateMark",
    "terminal",
    "terminalStdout",
    "providerList",
    "providerOption",
  ],
  memory: [
    "memoryDocument",
    "memoryForm",
    "memoryFormMark",
    "memoryTimelineEntry",
    "memoryRemoved",
    "memoryRemovedDoc",
  ],
  connections: ["connectionRow", "connectionCard"],
  mcp: ["connectionKey"],
  usage: ["usageStat"],
  approvals: [
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
  settings: ["settingsSection", "settingsMode"],
} as const satisfies Partial<Record<string, readonly UiHookName[]>>;

export type UiHookScreen = keyof typeof uiHooksByScreen;

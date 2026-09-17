export const runStates = ["queued", "running", "completed"] as const;

export type RunState = (typeof runStates)[number];

import { accountMeContract } from "./account.ts";
import { credentialsListContract } from "./credentials.ts";
import {
  botsArchiveContract,
  botsAvatarContract,
  botsClearAvatarContract,
  botsCreateContract,
  botsDeleteContract,
  botsGetContract,
  botsListContract,
  botsRestoreContract,
  botsSetAvatarContract,
  botsUpdateContract,
} from "./bots.ts";
import { deploymentStatusContract } from "./deployment.ts";
import {
  notificationsPreferencesContract,
  notificationsSetPreferenceContract,
} from "./notifications.ts";
import {
  routinesCreateContract,
  routinesListContract,
  routinesOutcomesContract,
  routinesPreviewContract,
  routinesRemoveContract,
  routinesTestRunContract,
  routinesUpdateContract,
} from "./routines.ts";
import {
  sectionsCreateContract,
  sectionsDeleteContract,
  sectionsListContract,
  sectionsUpdateContract,
} from "./sections.ts";
import {
  threadsClearContract,
  threadsCreateContract,
  threadsEventsContract,
  threadsListContract,
  threadsMessagesContract,
  threadsSendContract,
} from "./threads.ts";

/**
 * The application contract: the one source of transport truth (PRD decision
 * 15). Every procedure's input, output and typed errors live here, the API
 * implements this object, and clients consume it through the derived router
 * type in `client.ts`. Adding a procedure is an edit to this tree; the client
 * type, the server's compile-time completeness check and the OpenAPI document
 * all follow from it without a hand-written duplicate at any boundary.
 */
export const appContract = {
  deployment: {
    status: deploymentStatusContract,
  },
  account: {
    me: accountMeContract,
  },
  notifications: {
    preferences: notificationsPreferencesContract,
    setPreference: notificationsSetPreferenceContract,
  },
  bots: {
    list: botsListContract,
    get: botsGetContract,
    create: botsCreateContract,
    update: botsUpdateContract,
    archive: botsArchiveContract,
    restore: botsRestoreContract,
    delete: botsDeleteContract,
    setAvatar: botsSetAvatarContract,
    avatar: botsAvatarContract,
    clearAvatar: botsClearAvatarContract,
  },
  sections: {
    list: sectionsListContract,
    create: sectionsCreateContract,
    update: sectionsUpdateContract,
    delete: sectionsDeleteContract,
  },
  threads: {
    create: threadsCreateContract,
    list: threadsListContract,
    messages: threadsMessagesContract,
    send: threadsSendContract,
    clear: threadsClearContract,
    events: threadsEventsContract,
  },
  routines: {
    list: routinesListContract,
    create: routinesCreateContract,
    update: routinesUpdateContract,
    remove: routinesRemoveContract,
    preview: routinesPreviewContract,
    testRun: routinesTestRunContract,
    outcomes: routinesOutcomesContract,
  },
  credentials: {
    list: credentialsListContract,
  },
};

/**
 * Every procedure a caller may reach without a session, by contract path.
 *
 * The list is the reviewable inventory the PRD's "public is an explicit act"
 * asks for: marking a contract with `publicProcedure` without listing it here —
 * or listing a path that is not public — fails `access.test.ts`. A new entry is
 * meant to be argued for in review, not inferred from the absence of a marker.
 */
export const publicProcedures = ["deployment.status"] as const;

export type AppContract = typeof appContract;

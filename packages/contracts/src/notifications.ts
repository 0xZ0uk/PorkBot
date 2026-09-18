import { NOTIFICATION_KINDS } from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The notification preferences module (slice 8.6, PRD decision 33; story 35).
 *
 * The events an operator can be notified for and their quiet defaults live in
 * `@porkbot/core`; the stored choices live behind the actor-scoped store. This
 * module is the transport surface of the same vocabulary: `notifications
 * .preferences` reads every kind with the defaults filled in, and
 * `notifications.setPreference` flips exactly one switch and returns the whole
 * set, so a settings surface never has to merge a partial response.
 *
 * Neither input names a space, a user or an event source. The actor's session
 * resolves to the scope the store was built from, so a caller can only ever
 * read or write its own switches; the notification kinds are the only values a
 * caller chooses, and they are the closed vocabulary `@porkbot/core` owns.
 */

export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);

export const notificationPreferenceSchema = z.object({
  kind: notificationKindSchema,
  enabled: z.boolean(),
});

/**
 * Every kind, always present, in the vocabulary's order. A client renders the
 * set as given; it never has to know which kinds exist or what an absent one
 * would mean.
 */
export const notificationPreferencesSchema = z.object({
  preferences: z.array(notificationPreferenceSchema),
});

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;
export type NotificationPreferencesView = z.infer<typeof notificationPreferencesSchema>;

export const notificationsPreferencesContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/notifications/preferences",
    operationId: "notificationsPreferences",
    summary: "The operator's notification switches, quiet defaults filled in",
  })
  .output(notificationPreferencesSchema);

export const notificationsSetPreferenceContract = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/notifications/preferences/{kind}",
    operationId: "notificationsSetPreference",
    summary: "Turn one notification kind on or off",
  })
  .input(
    z.object({
      kind: notificationKindSchema,
      enabled: z.boolean(),
    }),
  )
  .output(notificationPreferencesSchema);

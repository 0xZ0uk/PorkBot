import { createHash } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { UserActor } from "./actor.ts";
import type { PostgresDatabase } from "./database.ts";
import { oauthState, webhookDelivery } from "./schema/ingress.ts";

/**
 * The ingress ledgers: webhook delivery dedupe and one-time OAuth state.
 *
 * Both are pre-actor paths, like `readDeploymentSettings` and
 * `bootstrapSignup`: a provider's webhook arrives with no session, and an OAuth
 * callback arrives before the actor it was started for is re-established. They
 * therefore take provider data (a source, a delivery id, a state) rather than a
 * tenant id, and the OAuth issuer is the one function that takes the initiating
 * `UserActor` — the binding is written from the actor, never from an argument.
 *
 * The rules the slice's acceptance criteria ask for are database behaviour, not
 * application bookkeeping:
 *
 *   - A replay of the same `(source, delivery_id)` is a no-op because the
 *     insert conflicts on the unique index and returns no row; two concurrent
 *     deliveries of the same id race at the index and exactly one wins.
 *   - A delivery row carries `expires_at`, and every recording first deletes
 *     the rows past it. The table is bounded by the dedupe window rather than
 *     by a scheduler, and the sweep uses the `expires_at` index.
 *   - `consume` is one atomic update whose `consumed_at is null` predicate is
 *     the one-time check: the first caller returns the binding, every replay
 *     matches no row. `expires_at > now` is in the same statement, so an
 *     expired state cannot be consumed at all, and a consumed row stays until
 *     its expiry — a replay is refused by the predicate, not by absence.
 *   - Only the SHA-256 of the state is stored. A leaked table cannot be used to
 *     replay a callback, for the same reason no other secret is stored in the
 *     clear.
 *
 * `release` is the failure path: a delivery whose handler threw is deleted so a
 * provider's redelivery is dispatched again instead of being deduped into a
 * silent loss. A finished delivery stays recorded for its TTL.
 */

/** How long a delivery id is remembered, in seconds. */
export const webhookDeliveryTtlSeconds = 86_400;

/** How long an OAuth flow's state stays consumable, in seconds. */
export const oauthStateTtlSeconds = 600;

export interface RecordWebhookDeliveryInput {
  readonly source: string;
  readonly deliveryId: string;
  /** Overrides `webhookDeliveryTtlSeconds`; a test uses a short window. */
  readonly ttlSeconds?: number;
  /** The clock the row is written against; defaults to now. */
  readonly now?: Date;
}

export interface ReleaseWebhookDeliveryInput {
  readonly source: string;
  readonly deliveryId: string;
}

export interface IssueOAuthStateInput {
  /** The actor that started the flow; the binding is taken from it, not from arguments. */
  readonly actor: UserActor;
  /** The raw state value; only its hash is stored. */
  readonly state: string;
  /** Overrides `oauthStateTtlSeconds`; a test uses a short window. */
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

/** The actor and space one OAuth flow was started for. */
export interface OAuthStateBinding {
  readonly spaceId: string;
  readonly userId: string;
}

export interface DeliveryLedger {
  /**
   * Records a delivery id, returning `true` when it was new and `false` when it
   * is a replay. A replay is a no-op: no row is written, nothing is dispatched.
   */
  record(input: RecordWebhookDeliveryInput): Promise<boolean>;
  /** Forgets a delivery so the provider's redelivery reaches the handler again. */
  release(input: ReleaseWebhookDeliveryInput): Promise<void>;
}

export interface OAuthStateStore {
  /**
   * Binds a fresh state to the initiating actor and space, hashed at rest.
   * Returns `false` when that state value is already known — the binding is
   * never replaced, so a caller that cannot produce a fresh state fails closed
   * rather than handing the flow to whoever holds the old one.
   */
  issue(input: IssueOAuthStateInput): Promise<boolean>;
  /**
   * Consumes a state exactly once. Returns the bound actor and space, or
   * `undefined` for a state that is unknown, already consumed or expired.
   */
  consume(state: string, now?: Date): Promise<OAuthStateBinding | undefined>;
}

export type IngressStore = DeliveryLedger & OAuthStateStore;

export function createIngressStore(database: PostgresDatabase): IngressStore {
  return {
    async record(input: RecordWebhookDeliveryInput): Promise<boolean> {
      const now = input.now ?? new Date();
      const ttlSeconds = input.ttlSeconds ?? webhookDeliveryTtlSeconds;

      await database.delete(webhookDelivery).where(lte(webhookDelivery.expiresAt, now));

      const inserted = await database
        .insert(webhookDelivery)
        .values({
          source: input.source,
          deliveryId: input.deliveryId,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
        })
        .onConflictDoNothing({ target: [webhookDelivery.source, webhookDelivery.deliveryId] })
        .returning({ id: webhookDelivery.id });

      return inserted.length > 0;
    },

    async release(input: ReleaseWebhookDeliveryInput): Promise<void> {
      await database
        .delete(webhookDelivery)
        .where(
          and(
            eq(webhookDelivery.source, input.source),
            eq(webhookDelivery.deliveryId, input.deliveryId),
          ),
        );
    },

    async issue(input: IssueOAuthStateInput): Promise<boolean> {
      const now = input.now ?? new Date();
      const ttlSeconds = input.ttlSeconds ?? oauthStateTtlSeconds;

      await database.delete(oauthState).where(lte(oauthState.expiresAt, now));

      const inserted = await database
        .insert(oauthState)
        .values({
          stateHash: hashOAuthState(input.state),
          spaceId: input.actor.spaceId,
          userId: input.actor.userId,
          expiresAt: new Date(now.getTime() + ttlSeconds * 1_000),
        })
        .onConflictDoNothing({ target: oauthState.stateHash })
        .returning({ id: oauthState.id });

      return inserted.length > 0;
    },

    async consume(state: string, now = new Date()): Promise<OAuthStateBinding | undefined> {
      const consumed = await database
        .update(oauthState)
        .set({ consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(oauthState.stateHash, hashOAuthState(state)),
            isNull(oauthState.consumedAt),
            gt(oauthState.expiresAt, now),
          ),
        )
        .returning({ spaceId: oauthState.spaceId, userId: oauthState.userId });

      return consumed[0];
    },
  };
}

/** The one hashing function the issuer and the consumer share. */
export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

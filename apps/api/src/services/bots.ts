import type { StorageProvider } from "@porkbot/adapter-kit";
import { maxAvatarBytes } from "@porkbot/contracts";
import type { BotRecord, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";

/**
 * The bot service: the one place a bot's avatar bytes meet the storage seam,
 * and the one place bot deletion is more than a row statement.
 *
 * The bot row keeps a storage key, never a path or a provider URL, and this
 * module is the only code that turns that key into bytes. The key is derived
 * from the bot's own scope and id — `avatars/<space>/<bot>` — so it cannot name
 * another space's object, and every operation reads the bot inside the actor's
 * scope first, so a foreign id writes no bytes at all. That is the "no second
 * storage path" rule: upload, read, clear and delete all go through the same
 * `StorageProvider` and the same key convention.
 *
 * Deletion is ordered deliberately: the object first, then the row. A storage
 * refusal therefore leaves the bot untouched and the request retryable, and the
 * failure mode of the other ordering — a live bot pointing at bytes that were
 * deleted — is reduced to a row delete that failed after the bytes went away,
 * which reads as "no avatar" rather than an error. The computer and home
 * directory are deliberately not touched here: they belong to epic E7, which
 * owns their lifecycle, and this slice documents that retention instead of
 * inventing a deletion two slices early.
 */

/** Where one bot's avatar lives in the seam. Deterministic, so it is also its own cleanup handle. */
export function avatarStorageKey(spaceId: string, botId: string): string {
  return `avatars/${spaceId}/${botId}`;
}

export interface AvatarBytes {
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface BotService {
  setAvatar(input: {
    readonly repositories: UserRepositories;
    readonly id: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<BotRecord>;
  readAvatar(input: {
    readonly repositories: UserRepositories;
    readonly id: string;
  }): Promise<AvatarBytes>;
  clearAvatar(input: {
    readonly repositories: UserRepositories;
    readonly id: string;
  }): Promise<BotRecord>;
  deleteBot(input: {
    readonly repositories: UserRepositories;
    readonly id: string;
  }): Promise<BotRecord>;
}

export function createBotService(storage: StorageProvider): BotService {
  async function removeObject(repositories: UserRepositories, id: string): Promise<void> {
    const bot = await repositories.bots.findById(id);

    // Only the derived key is ever deleted: a row that names another object is
    // not this service's to erase, and the key convention is the cleanup rule
    // itself.
    if (bot.avatarKey !== null && bot.avatarKey === avatarStorageKey(bot.spaceId, bot.id)) {
      await storage.delete(bot.avatarKey);
    }
  }

  return {
    async setAvatar({ repositories, id, contentType, bytes }): Promise<BotRecord> {
      // The scoped read comes first so a bot in another space never causes a
      // write into this deployment's storage.
      const bot = await repositories.bots.findById(id);
      const key = avatarStorageKey(bot.spaceId, bot.id);

      await storage.put({
        key,
        contentType,
        body: (async function* one() {
          yield bytes;
        })(),
      });

      try {
        return await repositories.bots.setAvatar(id, key);
      } catch (error) {
        // The row refused the key (a concurrent delete is the realistic case),
        // so the object would be unreachable. Best-effort cleanup keeps the
        // seam from accumulating orphans; the failure that mattered is rethrown.
        await storage.delete(key).catch(() => undefined);
        throw error;
      }
    },

    async readAvatar({ repositories, id }): Promise<AvatarBytes> {
      const bot = await repositories.bots.findById(id);
      const expectedKey = avatarStorageKey(bot.spaceId, bot.id);

      // The key is derived, not stored data: a row pointing anywhere else was
      // not written by this service, and reading through it would be a second
      // storage path. It reads as no avatar instead.
      if (bot.avatarKey !== expectedKey) {
        throw new NotFoundError("avatar", id);
      }

      const found = await storage.get(expectedKey);

      if (found === undefined) {
        // The row names an object the seam no longer holds. That is "no
        // avatar", not a corrupt bot: the bytes are gone and the next upload
        // replaces the key.
        throw new NotFoundError("avatar", id);
      }

      return {
        contentType: found.object.contentType ?? "application/octet-stream",
        bytes: await collect(found.body),
      };
    },

    async clearAvatar({ repositories, id }): Promise<BotRecord> {
      await removeObject(repositories, id);

      return repositories.bots.setAvatar(id, null);
    },

    async deleteBot({ repositories, id }): Promise<BotRecord> {
      await removeObject(repositories, id);

      return repositories.bots.delete(id);
    },
  };
}

/**
 * Reads an object into memory. Avatars are bounded by the upload contract, so
 * an object larger than that bound is not one this API could have written; it
 * is refused as a defect rather than buffered.
 */
async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of body) {
    total += chunk.byteLength;

    if (total > maxAvatarBytes) {
      throw new Error("the stored avatar exceeds the avatar size the upload contract allows");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

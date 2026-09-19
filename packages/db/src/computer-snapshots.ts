import { NotFoundError } from "@porkbot/effect";
import type { UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { insertedRow, requiredRow } from "./rows.ts";

/**
 * The snapshot index (slice 7.5, PRD story 30), over the `computer_snapshot`
 * table.
 *
 * The archive bytes live in the storage seam under `storageKey`; this module
 * owns only the row that names them and the two facts a restore verifies them
 * with. Every statement binds the actor's `space_id`, so a snapshot is read and
 * written only inside the space that took it: a foreign snapshot id is the
 * shared `NotFoundError`, not a row another space could restore.
 *
 * `create` is scoped through the bot's own row with `insert ... select`, so a
 * capture can only be recorded against a bot the actor can see; a bot in
 * another space matches no row and nothing is inserted. `listForBot` reads the
 * bot first for the same reason — an empty list would be indistinguishable from
 * a foreign bot, and the caller deserves the refusal.
 *
 * The store is deliberately immutable: a snapshot row is a record of what was
 * captured, and a restore reads it rather than editing it. Pruning is not a
 * v1.0 surface; the bot's foreign key cascades the rows away with the bot.
 */

/** The columns every read returns, aliased to the record's shape once. */
const snapshotColumns =
  'id, bot_id as "botId", snapshot_id as "snapshotId", ' +
  'storage_key as "storageKey", size_bytes as "sizeBytes", checksum, ' +
  'created_at as "createdAt"';

export interface ComputerSnapshotRecord {
  readonly id: string;
  readonly botId: string;
  readonly snapshotId: string;
  /** The storage-seam key the archive lives under. */
  readonly storageKey: string;
  readonly sizeBytes: number;
  /** Lowercase hex SHA-256 of the archive's bytes, as captured. */
  readonly checksum: string;
  readonly createdAt: Date;
}

export interface NewComputerSnapshot {
  readonly botId: string;
  readonly snapshotId: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly checksum: string;
}

/**
 * The wire shape of a raw row: the driver hands a `bigint` column back as a
 * string, and the record promises a number, so every read passes through
 * `toRecord` rather than letting the declared type lie about what the caller
 * receives.
 */
interface SnapshotRow extends Omit<ComputerSnapshotRecord, "sizeBytes"> {
  readonly sizeBytes: string | number;
}

function toRecord(row: SnapshotRow): ComputerSnapshotRecord {
  return { ...row, sizeBytes: Number(row.sizeBytes) };
}

export interface ComputerSnapshots {
  /** Records a capture, or throws `NotFoundError` for a bot outside the actor's space. */
  create(input: NewComputerSnapshot): Promise<ComputerSnapshotRecord>;
  /** The scoped read: a missing id and one in another space are the same refusal. */
  findById(id: string): Promise<ComputerSnapshotRecord>;
  /** Newest first; a bot outside the actor's space is a `NotFoundError`. */
  listForBot(botId: string): Promise<readonly ComputerSnapshotRecord[]>;
}

export function createComputerSnapshotStore(
  actor: UserActor,
  database: Queryable,
): ComputerSnapshots {
  async function requireBot(botId: string): Promise<void> {
    const { rows } = await database.query<{ readonly id: string }>(
      "select id from bot where id = $1 and space_id = $2",
      [botId, actor.spaceId],
    );

    if (rows[0] === undefined) {
      throw new NotFoundError("bot", botId);
    }
  }

  return {
    async create(input: NewComputerSnapshot): Promise<ComputerSnapshotRecord> {
      const { rows } = await database.query<SnapshotRow>(
        `insert into computer_snapshot ` +
          `(space_id, bot_id, snapshot_id, storage_key, size_bytes, checksum) ` +
          `select $1, b.id, $3, $4, $5, $6 from bot b ` +
          `where b.id = $2 and b.space_id = $1 ` +
          `returning ${snapshotColumns}`,
        [
          actor.spaceId,
          input.botId,
          input.snapshotId,
          input.storageKey,
          input.sizeBytes,
          input.checksum,
        ],
      );

      // The insert matched no bot: the actor cannot see the bot it named.
      return toRecord(insertedRowOrNotFound(rows, input.botId));
    },

    async findById(id: string): Promise<ComputerSnapshotRecord> {
      const { rows } = await database.query<SnapshotRow>(
        `select ${snapshotColumns} from computer_snapshot where id = $1 and space_id = $2`,
        [id, actor.spaceId],
      );

      return toRecord(requiredRow(rows, "snapshot", id));
    },

    async listForBot(botId: string): Promise<readonly ComputerSnapshotRecord[]> {
      await requireBot(botId);

      const { rows } = await database.query<SnapshotRow>(
        `select ${snapshotColumns} from computer_snapshot ` +
          `where space_id = $1 and bot_id = $2 order by created_at desc, id desc`,
        [actor.spaceId, botId],
      );

      return rows.map(toRecord);
    },
  };
}

/**
 * `insert ... select` yields no row when its select matched nothing, and the
 * caller named the bot that should have matched, so the empty result is a
 * scoped refusal rather than a database defect.
 */
function insertedRowOrNotFound<Row>(rows: readonly Row[], botId: string): Row {
  if (rows[0] === undefined) {
    throw new NotFoundError("bot", botId);
  }

  return insertedRow(rows);
}

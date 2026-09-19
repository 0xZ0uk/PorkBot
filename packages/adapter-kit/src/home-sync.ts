/**
 * The home-sync story per computer provider (slice 7.7, PRD story 5).
 *
 * A nightly backup of a bot's home directory is only meaningful if the storage
 * location is known. With a local Docker computer the home is a volume on the
 * same host; with a cloud computer the home lives on a remote machine that may
 * be destroyed at any time, so "the volume is on disk" is not a backup story at
 * all. This register states, for every implementation the provider plan names
 * for `ComputerProvider`, either how the home's bytes reach the storage seam or
 * that they are explicitly not backed up.
 *
 * The rule is checked, not wished: `home-sync.test.ts` walks the provider plan
 * and fails when a planned computer provider has no story, when a story names a
 * provider the plan does not declare, or when a story is empty. Adding a
 * computer provider therefore fails until its home story is stated, which is
 * the review moment the backup slice (12.3) depends on.
 */

export interface ComputerHomeSyncStory {
  /** The `ComputerProvider` implementation in `PROVIDER_INTERFACES` this is about. */
  readonly provider: string;
  /** Where the home's bytes live after the computer is gone, or why they do not. */
  readonly story: string;
  /**
   * True when `StorageProvider` is the path the home's bytes travel; false when
   * this provider's homes are explicitly not backed up.
   */
  readonly throughStorage: boolean;
}

export const COMPUTER_HOME_SYNC: readonly ComputerHomeSyncStory[] = [
  {
    provider: "ComputerEmulator",
    story:
      "The emulator's home is process memory that disappears with the test. It is explicitly not backed up: there is no volume, no machine and no bytes for a backup job to read.",
    throughStorage: false,
  },
  {
    provider: "createSupervisorComputerProvider",
    story:
      "The client holds no home: it is the transport the API and the worker use to reach whichever provider the supervisor owns. Snapshot and restore cross this seam unchanged, so the home's bytes reach the storage seam through the delegate's story — the Docker volume or the cloud instance behind the supervisor — and a deployment that never runs the snapshot job has no home backup.",
    throughStorage: true,
  },
  {
    provider: "createDockerComputerProvider",
    story:
      "The home is a named Docker volume on the host. A backup reads it through the snapshot path — capture the home, write the archive through the storage seam — so the archive outlives the container and the volume, and restore replays it into a rebuilt computer. A deployment that never runs the snapshot job has no home backup.",
    throughStorage: true,
  },
  {
    provider: "createCloudComputerProvider",
    story:
      "The home lives on the remote instance and is unreachable except through the provider. The snapshot path is the sync: capture writes the archive through the storage seam, and a reclaimed instance is rebuilt by restoring that archive. A provider that cannot snapshot its home is documented as not backed up before it ships, and the computer lease is released rather than pretended durable.",
    throughStorage: true,
  },
];

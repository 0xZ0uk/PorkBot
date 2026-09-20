import { integration } from "@porkbot/testkit";

// The backup app's database-backed tier: the suite boots the testkit harness
// (or attaches to the one CI started), clones a migrated template, and runs the
// real pg_dump/pg_restore pair against it from inside the built backup image,
// so the drill proves a restore into a scratch database rather than a fake
// restore seam.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });

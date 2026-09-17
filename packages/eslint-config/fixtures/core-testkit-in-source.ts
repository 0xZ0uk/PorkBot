// The test-only edge, from the rejected side: the same import as
// fixtures/core-testkit-in-test.test.ts, on a path that is shipped source. The
// harness must not be reachable from production code.
import { unit } from "@porkbot/testkit";

export const config = unit;

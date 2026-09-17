// The test-only edge, from the allowed side: `@porkbot/core` may not import
// `@porkbot/testkit` from shipped source, but this path is a test file, so the
// wider `testImports` edge set applies and the import is legal. This fixture is
// in `allowedFixtures`, so a rule that started rejecting it would fail CI.
import { unit } from "@porkbot/testkit";

export const config = unit;

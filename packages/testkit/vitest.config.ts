import { unit } from "@porkbot/testkit";

// Unit tier. The specs under test/fixtures/ are inputs to the flake tests: they
// are meant to be flaky, so they are never collected as part of this package's
// own run.
export default unit({ additionalExclude: ["**/test/fixtures/**"] });

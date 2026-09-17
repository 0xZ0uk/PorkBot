import { unit } from "@porkbot/testkit";

// Unit tier: the specs under src/, no retries, coverage on. Whole-process specs
// live in the e2e tier (vitest.e2e.config.ts) and never run here.
export default unit();

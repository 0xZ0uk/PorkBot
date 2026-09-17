import { unit } from "@porkbot/testkit";

// Unit tier: coverage thresholds gate this package, per PRD decision 45.
export default unit({
  coverageThresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
});

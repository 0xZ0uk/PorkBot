import { unit } from "@porkbot/testkit";

// Unit tier. Timeouts, retry policy (none here), coverage and the quarantine
// ledger all come from the shared tier presets in @porkbot/testkit.
export default unit();

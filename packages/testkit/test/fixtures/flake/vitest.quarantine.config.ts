import { unit } from "@porkbot/testkit";

// The ledger path comes from the environment: the test that runs this writes a
// ledger with dates relative to today, because a checked-in expiry would rot.
const ledgerFile = process.env["FLAKE_LEDGER_FILE"];

const options = { include: ["test/fixtures/flake/quarantine.fixture.ts"] };

export default unit(ledgerFile === undefined ? options : { ...options, ledgerFile });

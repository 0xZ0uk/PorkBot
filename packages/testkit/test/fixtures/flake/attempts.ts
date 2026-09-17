import { appendFileSync, readFileSync } from "node:fs";

// The fixtures record how many times they actually ran, so a test outside the
// worker can prove whether the runner retried them. Counting attempts is the
// only way to tell "the retry policy worked" from "the test happened to pass".
export function recordAttempt(): number {
  const file = process.env["FLAKE_ATTEMPTS_FILE"];

  if (file === undefined) {
    throw new Error("FLAKE_ATTEMPTS_FILE must point at a file the fixture can append to.");
  }

  appendFileSync(file, "attempt\n");

  return readFileSync(file, "utf8").trim().split("\n").length;
}

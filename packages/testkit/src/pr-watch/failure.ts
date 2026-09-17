/**
 * Telling a test failure apart from an infrastructure failure. The rerun guard
 * in commands.ts refuses to rerun a job classified as an assertion, because a
 * retry that passes hides a bug: the honest way to call a test failure
 * unrelated is to reproduce it on the base revision and record that, not to
 * press rerun until green. Infrastructure failures — setup, action download,
 * runner shutdown, disk, service health — are safe to retry on their own
 * evidence.
 *
 * Assertion patterns win ties: when a log looks like both, the guard treats it
 * as a test failure and asks for proof.
 */

export type FailureKind = "infrastructure" | "assertion" | "unknown";

export interface FailureClassification {
  readonly kind: FailureKind;
  readonly evidence: readonly string[];
}

const assertionPatterns: readonly RegExp[] = [
  /^\s*(?:✘|✗|×)\s/,
  /^\s*FAIL(?:ED)?\b/,
  /\bAssertionError\b/,
  /\bTest Files?\s+\d+ failed\b/,
  /^\s*Failed Tests?\b/,
  /^\s*Expected\b/,
  /^\s*Received\b/,
  /^\s*[-+]\s*(?:Expected|Received)\b/,
  /\bError: expect\(/,
  /^\s*at .*\.(?:test|spec)\.[cm]?[jt]sx?:\d+/,
  /<failing>/,
];

const infrastructurePatterns: readonly RegExp[] = [
  /Failed to resolve action download/i,
  /Unable to resolve action/i,
  /No space left on device/i,
  /Error response from daemon/i,
  /container .* is not running/i,
  /The runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /Connection reset by peer/i,
  /TLS handshake timeout/i,
  /i\/o timeout/i,
  /\bETIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b/,
  /Could not resolve host/i,
  /Service .* is unhealthy/i,
  /health check .* failed/i,
  /Error: Process completed with exit code 137\b/,
  /The operation was canceled/i,
];

// The lines worth surfacing from a raw CI log. Raw logs prefix every line with
// job, step and timestamp; `gh run view --log-failed` keeps the prefix, so the
// excerpt both strips it and keeps only the lines a human would scan for.
const keepPatterns: readonly RegExp[] = [
  /^\s*\d+\)\s/,
  /^\s*(?:Error|TimeoutError|AssertionError):/,
  /^\s*(?:Locator|Expected|Received|Timeout|Call log):/,
  /^\s*-\s+(?:Expect|waiting for|locator resolved)/,
  /^\s*>?\s*\d+ \| /,
  /^\s*\^/,
  /^\s*at .*\.(?:spec|test)\.[cm]?[jt]sx?:\d+/,
  /^\s*\d+ (?:failed|passed|flaky|skipped)/,
  /^\s*(?:✘|✗|×) /,
  /^##\[error\]/,
];

// Built from the character code rather than a literal so the escape stays out
// of the regex source, where `no-control-regex` would flag it.
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function stripLog(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/^(?:[^\t]*\t){2}\S+\s/, "").replace(ansiColor, ""))
    .join("\n");
}

function matchingLines(text: string, patterns: readonly RegExp[]): string[] {
  return text.split("\n").filter((line) => patterns.some((pattern) => pattern.test(line)));
}

function firstLines(text: string, limit: number): string[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, limit);
}

export function classifyFailure(rawLog: string): FailureClassification {
  const log = stripLog(rawLog);
  const assertions = matchingLines(log, assertionPatterns);

  if (assertions.length > 0) {
    return { kind: "assertion", evidence: assertions.slice(0, 3) };
  }

  const infrastructure = matchingLines(log, infrastructurePatterns);

  if (infrastructure.length > 0) {
    return { kind: "infrastructure", evidence: infrastructure.slice(0, 3) };
  }

  return { kind: "unknown", evidence: firstLines(log, 3) };
}

/**
 * A compact failing-log excerpt for `--logs`: interesting lines when the log has
 * any, the tail otherwise, with repeated `##[error]` lines collapsed and the
 * whole thing bounded so an agent is not handed a megabyte of Playwright noise.
 */
export function logExcerpt(rawLog: string, maxLines = 80): string {
  const lines = stripLog(rawLog).split("\n");
  const kept = lines.filter((line) => keepPatterns.some((pattern) => pattern.test(line)));
  const seenErrors = new Set<string>();
  const deduped = kept.filter((line) => {
    if (!line.startsWith("##[error]")) {
      return true;
    }

    if (seenErrors.has(line)) {
      return false;
    }

    seenErrors.add(line);
    return true;
  });
  const fallback = lines.filter((line) => line.trim() !== "");
  const chosen = deduped.length > 0 ? deduped : fallback.slice(-40);

  return chosen.slice(-maxLines).join("\n").trim();
}

import { POSTURE_FILE_RULES, checkPostureFiles } from "./files.ts";
import { publishedRefs, scanHistory } from "./history.ts";
import type { PostureFinding } from "./finding.ts";

/**
 * The public-posture policy, applied to the repository: the files that promise
 * what a stranger may do (license, contributing, security, conduct, templates)
 * plus every reachable commit and blob. The two halves share one check because
 * a leak and a missing disclosure route are the same class of failure at the
 * moment a repository goes public — something the reader has that the
 * maintainer did not intend.
 */

export interface PostureStats {
  readonly files: number;
  readonly commits: number;
  readonly blobs: number;
  readonly bytes: number;
}

export interface PostureReport {
  readonly findings: readonly PostureFinding[];
  readonly stats: PostureStats;
  readonly refs: readonly string[];
}

export function checkPosture(repoRoot: string, refs?: readonly string[]): PostureReport {
  const auditedRefs = refs ?? publishedRefs(repoRoot);
  const fileFindings = checkPostureFiles(repoRoot);
  const history = scanHistory(repoRoot, auditedRefs);

  return {
    findings: [...fileFindings, ...history.findings],
    stats: {
      files: POSTURE_FILE_RULES.length,
      commits: history.stats.commits,
      blobs: history.stats.blobs,
      bytes: history.stats.bytes,
    },
    refs: auditedRefs,
  };
}

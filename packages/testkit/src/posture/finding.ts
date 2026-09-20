/**
 * One public-posture finding. The detail is deliberately generic: a matched
 * value never reaches a log or a CI annotation, because both are public on a
 * public repository. The subject names where to look and the rule names what
 * the audit objected to; a maintainer opens the file or the commit to see it.
 */
export interface PostureFinding {
  readonly kind: "secret" | "personal-data" | "prose" | "file";
  readonly rule: string;
  readonly subject: string;
  readonly summary: string;
}

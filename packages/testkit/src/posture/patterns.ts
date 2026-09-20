/**
 * The registers behind the public-posture audit. They are one list each for the
 * same reason `BLOCKED_ADDRESS_RULES` is: a second place that decides "this is
 * a secret" or "this is personal data" is the bug the register exists to
 * prevent.
 *
 * The patterns deliberately do not include the noisy generic shapes — a long
 * random string, a `user:password@` placeholder URL, an `AKIA…EXAMPLE` AWS
 * documentation key. This repository is full of deliberate fixtures, and a rule
 * that cannot tell a fixture from a credential would be turned off within a
 * week. What is left is provider-shaped secrets and personal data that has no
 * legitimate place in committed content: real-looking access keys, private key
 * headers, non-reserved email addresses and personal home directories.
 *
 * A finding never prints the matched value. CI logs on a public repository are
 * public, so echoing the match would turn the audit into the leak it exists to
 * catch; the path, the commit and the rule id are enough to find it.
 */

export interface SecretPattern {
  readonly id: string;
  readonly summary: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: "secret/aws-access-key",
    summary: "an AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "secret/github-token",
    summary: "a GitHub token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: "secret/github-pat",
    summary: "a GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  },
  {
    id: "secret/slack-token",
    summary: "a Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "secret/stripe-key",
    summary: "a Stripe live key",
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "secret/openai-key",
    summary: "an OpenAI key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g,
  },
  {
    id: "secret/anthropic-key",
    summary: "an Anthropic key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "secret/google-api-key",
    summary: "a Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "secret/npm-token",
    summary: "an npm token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "secret/private-key",
    summary: "a PEM private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: "secret/jwt",
    summary: "a JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
];

export interface PersonalDataRule {
  readonly id: string;
  readonly summary: string;
  readonly pattern: RegExp;
  /** The account's home directory or the email's domain is allowed. */
  readonly allowed?: (capture: string) => boolean;
}

// Reserved domains and service accounts: values that cannot identify a person
// or a machine. Everything else in a committed blob, a commit identity or a
// commit message is a finding.
const reservedEmailDomains = [
  "example",
  "example.com",
  "example.net",
  "example.org",
  "example.test",
  "example.invalid",
  "invalid",
  "test",
  "localhost",
  "internal",
  "local",
  "users.noreply.github.com",
  "noreply.github.com",
];

// GitHub writes `noreply@github.com` as the committer of a merge it performs;
// it is an address of record, not a person.
const reservedEmailAddresses = ["noreply@github.com"];

const serviceAccountHomes = ["agent", "node", "runner", "ubuntu", "app", "vscode"];

export function isReservedEmail(value: string): boolean {
  const address = value.toLowerCase();

  if (reservedEmailAddresses.includes(address)) {
    return true;
  }

  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);

  return reservedEmailDomains.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  );
}

export function isServiceAccountHome(value: string): boolean {
  return serviceAccountHomes.includes(value.toLowerCase());
}

const emailRule: PersonalDataRule = {
  id: "personal/email",
  summary: "an email address that is not a reserved example domain",
  pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  allowed: isReservedEmail,
};

const homePathRule: PersonalDataRule = {
  id: "personal/home-path",
  summary: "a personal home directory outside the sandbox accounts",
  // The lookbehind-ish guard keeps a URL path (`https://host/home/x/`) from
  // matching: only a boundary that is not part of a path or host starts a home.
  pattern:
    /(?:^|[^A-Za-z0-9._/~-])(?:\/home|\/Users)\/([A-Za-z][A-Za-z0-9._-]*)\/|[A-Za-z]:\\Users\\([A-Za-z][A-Za-z0-9._-]*)\\/g,
  allowed: isServiceAccountHome,
};

const privateHostnameRule: PersonalDataRule = {
  id: "personal/private-hostname",
  summary: "a private or machine-local hostname",
  // The lookbehind is what keeps a filename like `.env.local` out: every
  // spelling of it has a dot immediately before the first label, so the rule
  // only sees a hostname that starts a token or follows a URL scheme.
  pattern: /(?:\bhttps?:\/\/|(?<![.\w/-]))(?:[A-Za-z0-9-]+\.)+(?:local|lan|corp|home\.arpa)\b/g,
};

const embeddedCredentialRule: PersonalDataRule = {
  id: "personal/embedded-credential",
  summary: "credentials embedded in a URL",
  pattern: /\/\/[^/\s:@]+:[^/\s:@]+@/g,
};

/** Content may not carry a secret or a personal identifier. */
export const CONTENT_PERSONAL_DATA_RULES: readonly PersonalDataRule[] = [emailRule, homePathRule];

/** Commit prose may not carry personal data, a private hostname or a credential. */
export const PROSE_PERSONAL_DATA_RULES: readonly PersonalDataRule[] = [
  emailRule,
  homePathRule,
  privateHostnameRule,
  embeddedCredentialRule,
];

export interface RuleMatch {
  readonly rule: string;
  readonly summary: string;
}

function captureFor(match: RegExpExecArray): string {
  const first = match[1];
  const second = match[2];

  return first ?? second ?? match[0];
}

function matchesRule(rule: PersonalDataRule, text: string): boolean {
  // A fresh instance per call: a shared `lastIndex` on a `/g` pattern is a
  // stateful bug that only shows up on the second scan.
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);

  for (const match of text.matchAll(pattern)) {
    const capture = captureFor(match as RegExpExecArray);

    if (rule.allowed !== undefined && rule.allowed(capture)) {
      continue;
    }

    return true;
  }

  return false;
}

/** True when a commit identity carries an address that identifies someone. */
export function isPersonalEmail(value: string): boolean {
  const match = new RegExp(emailRule.pattern.source).exec(value);

  return match !== null && !isReservedEmail(match[0]);
}

export function findSecretMatches(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const secret of SECRET_PATTERNS) {
    const pattern = new RegExp(secret.pattern.source, secret.pattern.flags);

    if (pattern.test(text)) {
      matches.push({ rule: secret.id, summary: secret.summary });
    }
  }

  return matches;
}

export function findPersonalDataMatches(
  text: string,
  rules: readonly PersonalDataRule[],
): RuleMatch[] {
  const matches: RuleMatch[] = [];

  for (const rule of rules) {
    if (matchesRule(rule, text)) {
      matches.push({ rule: rule.id, summary: rule.summary });
    }
  }

  return matches;
}

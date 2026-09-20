import { readFileSync } from "node:fs";
import path from "node:path";
import type { PostureFinding } from "./finding.ts";

/**
 * The file half of the public-posture audit. A public repository makes four
 * promises a stranger can check before they run anything: what the license
 * allows, how to contribute, how to report a vulnerability privately, and what
 * behaviour is expected. Each promise is one file here, and each check asserts
 * the promise is actually in the file rather than that the file exists — a
 * LICENSE that names the wrong license or a SECURITY.md with no route to
 * report through is the failure mode this exists for.
 *
 * The register is deliberately literal: the checks name the strings the
 * documents must contain, so editing one of these files is a reviewable diff
 * against a test rather than a prose change nobody notices.
 */

interface FileRule {
  readonly file: string;
  readonly rule: string;
  readonly summary: string;
  readonly requires: readonly (string | RegExp)[];
}

const licenseFile = "LICENSE";

export const POSTURE_FILE_RULES: readonly FileRule[] = [
  {
    file: licenseFile,
    rule: "file/license",
    summary: "the MIT license text and its copyright line",
    requires: [
      /^MIT License$/m,
      /^Copyright \(c\) \d{4} .+$/m,
      "Permission is hereby granted, free of charge",
      'THE SOFTWARE IS PROVIDED "AS IS"',
    ],
  },
  {
    file: "CONTRIBUTING.md",
    rule: "file/contributing",
    summary: "how to build, test and open a pull request",
    requires: [
      "AGENTS.md",
      ".github/pull_request_template.md",
      "pnpm install",
      "pnpm test:coverage",
      /never commit/i,
    ],
  },
  {
    file: "SECURITY.md",
    rule: "file/security",
    summary: "a private disclosure route",
    requires: ["security/advisories/new", /supported/i, "v1.0"],
  },
  {
    file: "CODE_OF_CONDUCT.md",
    rule: "file/conduct",
    summary: "the Contributor Covenant and an enforcement contact",
    requires: ["Contributor Covenant", "security/advisories/new"],
  },
  {
    file: ".github/ISSUE_TEMPLATE/bug_report.yml",
    rule: "file/bug-template",
    summary: "a bug report form GitHub renders",
    requires: ["name:", "description:", "body:", "type: textarea", "validations:"],
  },
  {
    file: ".github/ISSUE_TEMPLATE/feature_request.yml",
    rule: "file/feature-template",
    summary: "a feature request form GitHub renders",
    requires: ["name:", "description:", "body:", "type: textarea", "validations:"],
  },
  {
    file: ".github/pull_request_template.md",
    rule: "file/pull-request-template",
    summary: "the Why, What, Dependencies and How tested sections",
    requires: ["## Why", "## What", "## Dependencies", "## How tested"],
  },
  {
    file: "README.md",
    rule: "file/readme-links",
    summary: "the reader can find the license and the participation files",
    requires: ["LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"],
  },
];

function read(repoRoot: string, file: string): string | undefined {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

/** The manifest's `license` field is the machine-readable half of LICENSE. */
function checkManifestLicense(repoRoot: string): PostureFinding[] {
  const raw = read(repoRoot, "package.json");

  if (raw === undefined) {
    return [
      {
        kind: "file",
        rule: "file/manifest-license",
        subject: "package.json",
        summary: "the root manifest is missing, so its license field is unknown",
      },
    ];
  }

  let manifest: unknown;

  try {
    manifest = JSON.parse(raw);
  } catch {
    return [
      {
        kind: "file",
        rule: "file/manifest-license",
        subject: "package.json",
        summary: "the root manifest is not valid JSON",
      },
    ];
  }

  const license =
    typeof manifest === "object" && manifest !== null
      ? (manifest as Record<string, unknown>)["license"]
      : undefined;
  const fileLicense = read(repoRoot, licenseFile)?.split("\n")[0]?.trim();

  if (license !== "MIT" || fileLicense !== "MIT License") {
    return [
      {
        kind: "file",
        rule: "file/manifest-license",
        subject: "package.json",
        summary: "the manifest license and LICENSE must both say MIT",
      },
    ];
  }

  return [];
}

export function checkPostureFiles(repoRoot: string): PostureFinding[] {
  const findings: PostureFinding[] = [...checkManifestLicense(repoRoot)];

  for (const rule of POSTURE_FILE_RULES) {
    const text = read(repoRoot, rule.file);

    if (text === undefined) {
      findings.push({
        kind: "file",
        rule: rule.rule,
        subject: rule.file,
        summary: `${rule.file} is missing; it carries ${rule.summary}`,
      });
      continue;
    }

    for (const required of rule.requires) {
      const present = typeof required === "string" ? text.includes(required) : required.test(text);

      if (!present) {
        findings.push({
          kind: "file",
          rule: rule.rule,
          subject: rule.file,
          summary: `${rule.file} must carry ${rule.summary}`,
        });
        break;
      }
    }
  }

  return findings;
}

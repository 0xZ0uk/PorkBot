# Security Policy

PorkBot runs an agent with a shell and a browser on a machine you own, so a
security bug here is not abstract: report it, and it gets fixed.

## Supported versions

The project is pre-v1.0. Security fixes land on `main` and ship in the next
v1.0 release; once v1.0 is out, the latest minor line is supported and older
minor lines are not. A release's `build-manifest.json` records the commit it
was built from, which is the version to name in a report.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (or go directly to
   `https://github.com/0xZ0uk/PorkBot/security/advisories/new`).
3. Describe the issue in the form. The advisory stays private until a fix is
   released and a disclosure date is agreed.

Please include:

- the version or commit, and how it is deployed (single-host Compose, local
  stack, desktop app);
- what an attacker gains, and the conditions they need;
- reproduction steps or a minimal proof of concept;
- whether you want credit in the advisory, and under what name.

**Redact as you report.** Never paste real credentials, tokens, `.env` values,
tenant ids, personal data or a vulnerable machine's hostname into a report; use
placeholders. If a report already contains a live secret, rotate it before
anything else.

## What to expect

- Acknowledged within a few days.
- Triaged against the supported versions, with a severity and an impact
  assessment shared privately.
- A fix, tests and a release, or a clear explanation of why the behaviour is
  intended. You will be credited in the advisory unless you prefer otherwise.

## Scope

In scope: the application code in this repository — the API, the worker and
supervisor, the web and desktop clients, the database layer, the deployment
assets — and anything that breaks a boundary the project documents (the auth
gate, tenant isolation, the sandbox, the credential store, URL safety).

Out of scope:

- findings in third-party dependencies: report those upstream, though a note
  here is welcome if PorkBot needs to pin or work around them;
- a host that is already compromised, or an operator who deliberately disables
  a documented control;
- denial of service from a client you control on your own host;
- missing hardening that the operator documentation already names as the
  operator's responsibility.

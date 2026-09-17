<!--
Write the three sections below in words. Do not paste tool output, logs, or
screenshots of a terminal: describe what you ran and what it proved. Never
include secrets, personal or machine identifiers, local paths, usernames,
hostnames, or account ids. See AGENTS.md for the rules this template enforces.
-->

## Why

<!-- The product reason this change exists: what was wrong or missing, and what
this slice changes. Not "the agent was asked to". Link the issue. -->

## What

<!-- The change in prose: the modules touched, the decisions made, and anything
a reviewer should disagree with now rather than later. Keep it short. -->

## How tested

<!-- What you ran, in words, and the outcome. Name the tiers (format, lint,
typecheck, build, unit, integration, e2e) and what they proved. If something is
not covered, say so and why. -->

## Checklist

- [ ] Every acceptance criterion in the linked issue is addressed or explicitly deferred
- [ ] CI and review bots on the head commit are terminal and the pr-watch completion gate holds
- [ ] No secrets, credentials, personal data, or machine/account identifiers in the diff or this description
- [ ] UI changes link the CI screenshot that shows the change, or say why none exists

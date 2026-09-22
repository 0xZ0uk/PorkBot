# Should the platform be rewritten in a native language?

**Status:** Accepted  
**Date:** 2026-09-22  
**Epic:** E14 — Resource footprint & measured floors  
**Slice:** 14.12

## Context

The question "should this be Rust?" surfaces every time the deployment footprint is discussed. The concern is that Node.js services consume more memory than necessary, and that a native rewrite would make the platform cheaper to self-host.

The measured deployment floor ([operations-floor.md](../operations-floor.md)) — produced by `pnpm deploy:measure` on 2026-09-21 against a 12 vCPU / 31.20 GiB host running one bot on the offline and Docker providers — gives real numbers instead of estimates.

## Decision

**No rewrite.** The platform stays on Node 24 with the current workspace structure.

## The arithmetic

### What a native rewrite would recover

The five Node services from the measured floor:

| service  | idle memory | peak memory |
| -------- | ----------: | ----------: |
| api      | 122.7 MiB  | 141.7 MiB  |
| worker   | 120.4 MiB  | 132.1 MiB  |
| backup   | 92.5 MiB   | 176.8 MiB  |
| web      | 42.4 MiB   | 52.0 MiB   |
| supervisor| 80.4 MiB  | 90.9 MiB   |

A native rewrite of these five services would return roughly **650 MiB** of the measured **718.2 MiB** peak sum, or approximately **545 MiB** of the **545.0 MiB** idle sum. Against the measured total (including Postgres at 55.8–87.7 MiB and the proxy at 19.6–25.2 MiB), that is **10–15% of the ~1.5 GiB fixed footprint**.

### What a native rewrite would not recover

The per-bot cost is the sandbox image — the container a bot runs in, not the application services. This image is a provider concern (Docker or cloud), and its memory is outside the application's process tree regardless of language. A native rewrite does **nothing** to the per-bot term.

### What a native rewrite would cost

The repository is not a single service:

- 13 workspace packages, 5 applications
- The Effect-based domain (`@porkbot/core`)
- The Drizzle schema and its migration journal
- A Graphile Worker job queue (a rewrite would need to replace this)
- The Electron desktop client (shares the API contract)
- The entire test harness, CI gate, and the boundary enforcement in `packages/eslint-config`
- Every document in `docs/` that describes these seams

A rewrite is not a port. It is a re-architecture of the domain, the data layer, the job queue, the provider adapter system, and the client contracts — with the attendant risk of silent behavioral drift in a product whose safety guarantees depend on precise state transitions.

### The fixed costs that do not shrink

Postgres, the reverse proxy (Caddy), and the Docker daemon are independent of the application language. On a small host the daemon alone is a meaningful share of the fixed term. These three stay constant whether the application is Node, Rust, Go or anything else.

## Where native code does pay

Two components are genuine candidates for native reimplementation, as scoped replacements rather than a platform rewrite:

### 1. The supervisor

`apps/supervisor` is the lifecycle daemon: the sole holder of the Docker socket, the owner of computer provisioning, and the process that watches for idle machines. It is small, stateless relative to the database, and its interface to the rest of the platform is a single HTTP surface (`PORKBOT_SUPERVISOR_URL`). A static binary here is a genuinely better fit:

- no runtime dependency (no Node, no npm, no `node_modules` in the image)
- a single statically-linked executable that can be the container's entrypoint
- the Docker socket interaction is a thin wrapper over the Docker Engine API

**What would have to be true:** the binary implements the same HTTP contract the Node service exposes, the canary suite passes against it, and the offline emulator continues to work as a provider behind it.

### 2. The in-sandbox helper

The sandbox image carries a POSIX shell, a `timeout` command, and a `browser` command. This is the **only per-bot process the platform owns** — the one place where the metric that matters (per-bot memory) scales with the implementation. A smaller, statically-linked helper binary would directly reduce the per-bot floor:

- smaller image means less memory per container (shared read-only layers notwithstanding)
- a Rust or Go binary eliminates the Node runtime from the sandbox entirely
- the helper's interface is narrow: execute a command, stream output, enforce a timeout

**What would have to be true:** the binary implements the same tool-call protocol the current sandbox uses, the Docker and cloud providers can boot it, and the canary suite's tool-call step passes against it.

## What would change the verdict

The rewrite question reopens if:

1. **The per-bot cost becomes the dominant term and the sandbox image is the bottleneck.** If the platform reaches a bot density where the fixed footprint is dwarfed by per-bot memory, and the sandbox helper is the single largest per-bot contributor, then a native helper becomes the highest-leverage change — but that is the scoped replacement above, not a platform rewrite.
2. **A major upstream dependency disappears or changes license.** If Effect, Drizzle, or Graphile Worker become unavailable or incompatible, the rewrite cost resets.
3. **The host floor drops below 2 GiB.** At that point the fixed-term savings from a native rewrite would be a larger fraction of the total, and the arithmetic might favor it.

## References

- [Measured deployment floor](../operations-floor.md) — the table `pnpm deploy:measure` produced on 2026-09-21, the source of every number cited here
- Epic E14 (issue #244) — the footprint epic that frames this decision
- Slice 14.1 (issue #245) — the measurement harness that produced the floor table

# Architecture

This directory is the design record: why each subsystem is shaped the way it
is, which seam owns what, and the check that proves it. The operator-facing
docs start at [self-host.md](../self-host.md); [status.md](../status.md) says
what ships today.

| Document                         | What it records                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [runtime.md](runtime.md)         | The run session, tool dispatch and the tool-call timeline, approval gates, run fences and reclaim, the worker and routines |
| [computers.md](computers.md)     | The computer provider seam, the offline emulator, the Docker and cloud providers, snapshots and the model's tools          |
| [transport.md](transport.md)     | The contract, the auth gate, request limits, resumable streams, webhook ingress and MCP servers                            |
| [domain.md](domain.md)           | Bots and sections, threads and messages, files and artifacts, memory and notifications                                     |
| [safety.md](safety.md)           | Provider seams, URL safety and the untrusted-content boundary                                                              |
| [operations.md](operations.md)   | The local stack, the single-host deployment, backups and the live-provider canaries                                        |
| [development.md](development.md) | Module boundaries, dependencies, environment schemas, logging and migrations                                               |
| [clients.md](clients.md)         | The web shell, the thread console and the desktop shell                                                                    |
| [interface.md](interface.md)     | The workspace shell, bot identity, conversation grammar, state vocabulary, scales, register and screenshot set             |
| [testing.md](testing.md)         | The CI tiers, the Postgres-per-suite harness, flake management, coverage and required checks                               |

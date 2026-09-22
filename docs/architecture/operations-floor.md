# Measured deployment floor

Measured 2026-09-22T13:11:44.984Z on x86_64 with 12 vCPU and 31.20 GiB of daemon memory.
The workload used 1 bot(s) per provider (offline and Docker), with a requested idle window of 3600 seconds.
Docker server: 29.8.1.

This table is measured usage, not the Compose ceilings. The idle column is the largest current memory and CPU sample during the idle phases; peak is the largest cgroup peak or `docker stats` sample observed across the complete workload.
The one-shot migration and backup/restore job are covered by workload phases and are not included in the persistent-service totals.

<!-- prettier-ignore -->
| service | idle memory | peak memory | idle CPU | peak CPU | peak CPU time |
| --- | ---: | ---: | ---: | ---: | ---: |
| postgres | 62.4 MiB | 86.2 MiB | 8.88% | 8.88% | 48.85 s |
| api | 131.4 MiB | 143.3 MiB | 22.52% | 22.52% | 78.68 s |
| worker | 133.6 MiB | 145.2 MiB | 16.65% | 16.65% | 82.37 s |
| proxy | 29.3 MiB | 36.8 MiB | 3.23% | 3.23% | 12.60 s |
| supervisor | 91.3 MiB | 109.5 MiB | 9.75% | 9.75% | 75.24 s |
| bot-docker | 11.2 MiB | 11.9 MiB | 0.00% | 0.00% | 1.97 s |
| **sum of measured services** | **459.2 MiB** | **533.0 MiB** | — | — | **299.71 s** |

The raw samples are emitted as JSON by `pnpm deploy:measure`; the CI run uploads that file as the deployment-measurement artifact. Re-run the command with `--table-path docs/architecture/operations-floor.md` when replacing this record with a new host measurement.

## Workload coverage

<!-- prettier-ignore -->
| phase | status |
| --- | --- |
| cold-boot — cold boot of the already-built deployment stack | complete |
| migration — the deployment migration one-shot | complete |
| bots-idle — N offline and N Docker-provider computers provisioned and idle | complete |
| idle-hour — the stack and provider computers left idle for the requested window | complete |
| bots-offline-working — N offline-emulator computers executing a bounded shell workload | complete |
| bots-docker-working — N Docker-provider computers executing a bounded shell workload | complete |
| backup-restore-drill — a forced nightly backup followed by its restore drill | complete |

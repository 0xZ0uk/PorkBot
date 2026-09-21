# Measured deployment floor

Measured 2026-09-21T23:00:04.574Z on x86_64 with 12 vCPU and 31.20 GiB of daemon memory.
The workload used 1 bot(s) per provider (offline and Docker), with a requested idle window of 3600 seconds.
Docker server: 29.8.1.

This table is measured usage, not the Compose ceilings. The idle column is the largest current memory and CPU sample during the idle phases; peak is the largest cgroup peak or `docker stats` sample observed across the complete workload.
The one-shot migration is covered by the workload phase and is not included in the persistent-service totals.

<!-- prettier-ignore -->
| service                      |   idle memory |   peak memory | idle CPU | peak CPU | peak CPU time |
| ---------------------------- | ------------: | ------------: | -------: | -------: | ------------: |
| postgres                     |      55.8 MiB |      87.7 MiB |    5.42% |    5.42% |       48.53 s |
| api                          |     122.7 MiB |     141.7 MiB |   10.35% |   10.35% |       78.91 s |
| worker                       |     120.4 MiB |     132.1 MiB |   11.85% |   11.85% |       82.04 s |
| backup                       |      92.5 MiB |     176.8 MiB |   10.17% |   10.17% |       78.62 s |
| web                          |      42.4 MiB |      52.0 MiB |   10.83% |   10.83% |       73.64 s |
| proxy                        |      19.6 MiB |      25.2 MiB |    2.82% |    2.82% |       12.74 s |
| supervisor                   |      80.4 MiB |      90.9 MiB |   10.50% |   10.50% |       75.48 s |
| bot-docker                   |      11.1 MiB |      11.8 MiB |    0.00% |    0.00% |        1.88 s |
| **sum of measured services** | **545.0 MiB** | **718.2 MiB** |        — |        — |  **451.84 s** |

The raw samples are emitted as JSON by `pnpm deploy:measure`; the CI run uploads that file as the deployment-measurement artifact. Re-run the command with `--table-path docs/architecture/operations-floor.md` when replacing this record with a new host measurement.

## Workload coverage

<!-- prettier-ignore -->
| phase                                                                                  | status   |
| -------------------------------------------------------------------------------------- | -------- |
| cold-boot — cold boot of the already-built deployment stack                            | complete |
| migration — the deployment migration one-shot                                          | complete |
| bots-idle — N offline and N Docker-provider computers provisioned and idle             | complete |
| idle-hour — the stack and provider computers left idle for the requested window        | complete |
| bots-offline-working — N offline-emulator computers executing a bounded shell workload | complete |
| bots-docker-working — N Docker-provider computers executing a bounded shell workload   | complete |
| backup-restore-drill — a forced nightly backup followed by its restore drill           | complete |

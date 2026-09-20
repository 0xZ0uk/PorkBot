# The trust boundary (slice 12.7)

PRD stories 2 and 9. The acceptance criteria this document supports:

- the trust boundary is named in one place: what a bot can reach, where
  credentials live, and what this deployment protects;
- the non-goals are stated plainly, without marketing language, so an operator
  can decide what the host and the OS still owe;
- every claim here names the module or contract that enforces it.

This is the operator-facing statement. It describes what the shipped code does,
not an aspiration. Where something is the operator's responsibility, it says so.

## The boundary in one picture

```
internet ── 80/443 ──► caddy (deploy/Caddyfile)
                        └─ one origin ──► api ──► postgres, storage
                                          │
                                          ├─► supervisor ──► computer provider ──► bot machine
                                          └─► worker ──► model providers, webhooks
```

Only the proxy is public. The API and web hosts are loopback; Postgres, the
worker, the backup process and the supervisor are on the stack network and have
no published port. The one way in to the database is `pnpm deploy:exec`.

A bot's computer is a second boundary inside the first. A machine gets its own
internal Docker network with an isolated gateway; it reaches neither another
bot's machine nor a service on the host. The Docker socket is mounted into the
supervisor and nowhere else, and the API and worker reach computers through the
supervisor's authenticated surface with `PORKBOT_SUPERVISOR_TOKEN`.

## What a bot can reach

- **Its own machine, and nothing else.** `shell`, `file_read`, `file_write`,
  `file_list` and `browser` are bound to the run's computer at construction; no
  tool argument can name another machine. File tools are confined to the home.
- **The network only through the run's egress policy.** Web fetches and MCP
  calls go through `safeFetch`, which enforces HTTPS, refuses embedded
  credentials, and checks the resolved address on the connection, so a hostname
  that rebinds from public to private is refused on the socket. Ranges are one
  list (`BLOCKED_ADDRESS_RULES`); a second place that decides "private" is the
  bug the list exists to prevent. A host outside the run's allowlist is refused
  or opens the run's durable approval gate before a request is made.
- **A run's credentials only as opaque capabilities.** With the credential
  proxy configured, a machine holds `PORKBOT_PROXY_URL` and a per-command
  token; the upstream origin and the credential stay on the sidecar. Without
  the proxy, a run's model call is made by the worker, not the machine.
- **Stored bot secrets only through the mediated tool.** The agent can request
  a value for a declared destination and the server resolves it; a value is
  returned once, is never listed, and is bound to its destination so
  re-pointing it is a conflict. See [bot secrets](bot-secrets.md).
- **External content as data.** A web page, a file, an email body or a tool
  result is labelled untrusted at the boundary and rendered in the prompt's
  data channel under the data notice. The model is told the content is
  untrusted; it is not asked to trust it.

## Where credentials live

| Material                              | At rest                                                                                               | In the sandbox      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------- |
| Model/provider credentials            | `encrypted_credential` rows, AES-256-GCM under `PORKBOT_CREDENTIAL_KEYS`                              | never; a capability |
| Bot secrets                           | `bot_secret` rows, same keyring                                                                       | a one-time value    |
| Mail, webhook and webhook-source keys | `deploy/.env`, read by name at use                                                                    | never               |
| Database passwords                    | `deploy/.env`; applied to roles by the migrate one-shot                                               | never               |
| Supervisor and proxy capabilities     | signs with `PORKBOT_SUPERVISOR_TOKEN` / `PORKBOT_PROXY_TOKEN_SECRET`; tokens are short-lived          | a bound capability  |
| Sessions                              | opaque tokens in Postgres; cookie is `HttpOnly`, `SameSite=Lax`, `Secure` on https                    | never               |
| Backups                               | AES-256-GCM objects; the keyring is sealed in the envelope under `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE` | not applicable      |
| Desktop update manifests              | Ed25519 signature verified against the pinned public key                                              | not applicable      |
| Auth secret                           | `deploy/.env`; rotating it signs every session out                                                    | never               |

`deploy/.env` is mode 0600 and git-ignored; `pnpm deploy:setup` generates every
secret. Secret material is redacted before it reaches a log line, an error, a
list response or a sandbox. A notification request body is built from an
allowlist of title, body and link, so a credential or a raw tool argument
cannot ride along to a third party.

## What is protected, and by what

- **Every procedure is authenticated unless it is explicitly public.** The
  public paths are a hand-written list compared against the contract tree; an
  authenticated procedure resolves the session to an actor, and a by-id fetch
  is the actor-scoped repository read, so a foreign id is the shared `NOT_FOUND`
  before any data is returned.
- **Every space-scoped row has a cross-space refusal**, exercised by the
  authorization matrix against the real read and write seams.
- **The browser and API share one origin**, so there is no CORS grant to
  misconfigure; the cookie policy and the streaming contract are asserted
  against the shipped Caddy config.
- **Rate limits, body caps and stream slots** are decided in one register
  (`apps/api/src/limits.ts`); a path the register does not name draws the
  anonymous budget, and a refusal is the contract's typed `RATE_LIMITED` with a
  `Retry-After`, never an unbounded loop.
- **Streams resume from a signed, actor-bound cursor.** A malformed, forged or
  foreign cursor is refused; access is re-resolved on every subscribe, resume
  and frame, so a revoked membership cannot keep a stream open.
- **Dangerous actions are one register and the gate fires from it.** A write
  outside the home, egress outside the allowlist, credential-store access, a
  stored bot-secret request, and any send or delete open the run's durable
  approval gate. `shell` is deliberately outside the register: a command string
  names no single class, and the sandbox is its boundary.
- **Backups are encrypted and drilled.** A restore into a scratch database
  proves the canary reads back on schedule, not by hand.

## What is not protected

- **The host and the Docker daemon are the operator's security boundary.**
  Docker socket access is root-equivalent; anyone who holds the host, the
  socket or `deploy/.env` holds everything in the deployment. Disk encryption,
  OS patching, SSH policy, firewall rules and daemon hardening are the
  operator's, and the product does not audit them.
- **The single-host, single-operator trust model is the v1.0 model.** A
  multi-tenant deployment would need a trusted-proxy address policy (anonymous
  budgets key on the socket address and never trust `X-Forwarded-For`) and
  stronger separation than one Compose project; neither ships today.
- **The offline computer is not a sandbox.** It is an in-process emulator for
  development and for deployments that accept the trust model. It is not
  isolation, its home is not durable and it is explicitly not backed up.
- **The model provider sees the prompt.** Prompts include conversation content
  and labelled external data; choosing a provider, its data policy and its
  residency is the operator's decision. Injection defences are labels, tool
  gating and approval, which reduce risk; they do not make a model trustworthy.
- **There is no secrets-manager integration.** Secrets live in the environment
  file and in encrypted rows. Rotation recipes are in [the operator
  runbook](runbook.md#a-key-is-rotated); the credential keyring's re-encryption
  pass currently has no operator command, so retired key material must be kept
  until that lands.
- **No tamper-evident operator audit log ships.** The durable record is the
  run's event stream, the tool-call ledger and the structured logs with
  correlation ids; a host-level actor who can edit the database can edit those
  too.
- **A backup you cannot decrypt is a backup you do not have.** The envelope and
  the passphrase are two halves kept separately; losing both loses the data.
  The envelope is safe to copy into a vault only because the passphrase is
  never stored with it.
- **Desktop artifacts are not OS-signed by this project.** The Ed25519 manifest
  is the update trust boundary the app enforces; Apple notarization and Windows
  Authenticode are certificates the project does not hold, so a downloading
  operator decides whether to trust the publisher.
- **Public repository posture is a separate slice.** Secret scanning, branch
  protection, the disclosure policy and the history audit for the public launch
  are tracked as issue 12.8; this document is what the code protects, not a
  claim that the repository is already public-ready.

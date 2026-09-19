# Bot secrets the agent can request but not read twice (slice 9.6)

Reference parity: `BotSecret` and the `request_secret` / `list_secrets` /
`forget_secret` tool family. A bot secret is a named credential an operator
stores for one bot — a value, the one bare HTTPS origin it may be sent to, and
how it authenticates there. The agent can ask for it and use it through the
run's credential proxy; no tool, prompt, event, log or sandbox can read it.

## The flow

1. **The agent asks.** `request_secret` names the credential and its origin —
   for example `{ "name": "example_api", "origin": "https://api.example.test",
"auth": { "type": "bearer" } }`. The ask becomes the run's durable approval
   gate under the `credential_request` class, so the operator reviews the
   destination rather than a prompt. Nothing is injected into the model context.
2. **The operator answers.** A stored value can be approved as-is; a value that
   does not exist yet is stored first through
   `PUT /bots/{botId}/secrets/{name}` (`botSecrets.put`), which encrypts it into
   the bot secret rows bound to `(space, bot, name)`. The approval row carries
   the destination, the operator's identity and the instant.
3. **The run's proxy grows an upstream.** On approval the tool resolves the
   stored value _inside the run's credential proxy handle_ and republishes the
   grant. The value becomes one request header; the sandbox only ever learns
   the upstream name:
   `curl $PORKBOT_PROXY_URL/u/example_api/v1/items`.
4. **The value stays server-side.** The sandbox's environment carries only
   `PORKBOT_PROXY_URL` and a per-command capability, exactly as it does for the
   run's model credential. The proxy reads the grant per request, so the new
   upstream is reachable by the next command and a forget is immediate.

## The tools

| Tool             | Answers                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_secret` | `granted` (value stored and upstream published), `credential_missing` (approved, no value saved), a typed refusal, or the approval's denial. |
| `list_secrets`   | Names and statuses only — no value, no origin, no mask.                                                                                      |
| `forget_secret`  | Clears the value and takes the upstream back in the same call; the next request naming it is refused before any upstream is dialed.          |

## The trust posture

- **A destination binds the value.** A write that would re-point a stored value
  at another origin or another authentication mode is refused (`CONFLICT`); the
  operator forgets it first. An injected instruction cannot ask for a stored
  credential at an attacker's origin.
- **A value is never derivable from a list.** The operator's list answers the
  destination and a status (`stored` / `forgotten`); the agent's list answers
  names and statuses. No output schema carries the value or a mask.
- **A forget is immediate and audited.** The envelope is cleared before the call
  returns, the row keeps its destination and `forgotten_at` as the audit line,
  the upstream is removed from the run's grant, and the durable tool-call ledger
  records the call.
- **Rotation covers these rows too.** `BotSecrets.rotate()` re-encrypts every
  held value that is not on the active key, in the actor's space, exactly as the
  space credential store does.
- **Hostile content ships with the attack.** The injection fixtures include
  attempts to re-point a stored credential at a mirror origin and to read a
  secret out of the proxy capability
  (`packages/adapters/src/ingestion-fixtures.ts`), and the bot-secret tool suite
  proves the destination refusal on the call such content would cause.

## Where the pieces live

| Concern                     | Module                                                                         |
| --------------------------- | ------------------------------------------------------------------------------ |
| Vocabulary and header build | `packages/core/src/bot-secrets.ts`                                             |
| Durable rows and store      | `packages/db/src/bot-secret-store.ts`, `packages/db/src/schema/bot-secret.ts`  |
| Actor-scoped seams          | `packages/effect/src/bot-secrets.ts`                                           |
| Run proxy upstream growth   | `packages/effect/src/run-credential-proxy.ts`                                  |
| The model-facing tools      | `packages/effect/src/bot-secret-tools.ts`                                      |
| Operator surface            | `packages/contracts/src/bot-secrets.ts`, `apps/api/src/routers/bot-secrets.ts` |
| Danger class and gate       | `packages/core/src/dangerous-actions.ts` (`credential_request`)                |

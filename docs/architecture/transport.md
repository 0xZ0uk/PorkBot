# Transport and the API

## Transport

`packages/contracts` is the single source of transport truth (PRD decisions 14
and 15). Every procedure's input, output and typed errors live there as Zod
schemas composed with oRPC's contract builder; `appContract` is the tree the API
implements, and `AppClient` is derived from it — adding a procedure is an edit
to `contract.ts`, the server fails to compile until it implements the new
procedure, and no client-side type is written or updated by hand.

```ts
// packages/contracts/src/contract.ts — the contract tree
export const appContract = {
  deployment: { status: deploymentStatusContract },
  account: { me: accountMeContract },
  bots: { get: botsGetContract },
};

// packages/contracts/src/client.ts — the derived client
export type AppClient = ContractRouterClient<AppContract>;
export function createApiClient(options: { url: string | URL }): AppClient;
```

`apps/api` mounts the implemented router on Hono at `/rpc`, exposes `/livez`
for process liveness and `/readyz` for its database dependency (while keeping
`/healthz` as a legacy alias), and owns the request boundary: every response gets a
correlation id and a redacted request line, and a defect is logged redacted and
answered as a 500. Routers live in `apps/api/src/routers/`, delegate to the
services `main.ts` injects, and stay one screen each; contract schemas are the
only validation layer, so a handler sees parsed input and returns the declared
output — an output that violates its schema is rejected before it reaches the
wire.

```ts
// apps/api/src/routers/deployment.ts — one screen, no business logic
const status = publicOnly.deployment.status.handler(async ({ errors }) => {
  const result = await service.status();
  if (result.kind === "misconfigured") throw errors.SERVICE_UNAVAILABLE();
  return { signups: result.kind };
});
```

The OpenAPI document is generated from that same `appContract` object with
`createOpenApiDocument()`, and a test asserts the procedure's path, method,
operation id, success response and typed error in it. The transport libraries
are pinned in `dependencies.json` and owned by exactly one package in the module
map: `@orpc/contract` and `@orpc/client` belong to `@porkbot/contracts`, and
Hono, `@hono/node-server`, `@orpc/server`, `@orpc/openapi` and `@orpc/zod`
belong to `@porkbot/api`.

The API process reads `DATABASE_URL` and exits when it is missing. The local
stack supplies it in `compose.yaml`; unit tests inject a service, and the e2e
spec starts the process with a placeholder URL it never dials.

## Rate limits, body caps and connection caps

`apps/api/src/limits.ts` is the one place limits live (PRD decision 9). The
reference implementation had no rate limiting anywhere; the failure this module
is built against is a route added later that is silently unlimited, so it is
three single places:

- **One register.** `routeRules(rpcPath)` names every route family — the health
  probe, the whole `/rpc` surface, and the webhook family a later slice mounts —
  and the budget each draws from. A path the register does not know still draws
  the anonymous budget rather than none.
- **One installer.** `installLimits` registers the middleware before any route;
  the gate spends the RPC budget after it has resolved an actor, the middleware
  spends the rest, and both use the same accounting object.
- **One answer.** An RPC refusal is the contract's typed `RATE_LIMITED` with
  `{ retryAfterSeconds }` in its `data` and a `Retry-After` header; an HTTP
  surface gets a `429` JSON body and the same header. A refused stream gets the
  RPC error envelope when it is on the `/rpc` path.

What is limited, per minute unless noted:

| Surface                        | Key                  | Default | Variable                                 |
| ------------------------------ | -------------------- | ------- | ---------------------------------------- |
| Authenticated RPC              | actor (`space:user`) | 300     | `PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE` |
| Public RPC and unmatched paths | client address       | 60      | `PORKBOT_LIMIT_ANONYMOUS_PER_MINUTE`     |
| Health probe                   | client address       | 600     | `PORKBOT_LIMIT_PROBE_PER_MINUTE`         |
| Inbound webhooks               | client address       | 120     | `PORKBOT_LIMIT_WEBHOOK_PER_MINUTE`       |
| Attachment uploads             | client address       | 60      | `PORKBOT_LIMIT_UPLOAD_PER_MINUTE`        |
| RPC request body               | —                    | 1 MiB   | `PORKBOT_LIMIT_MAX_BODY_BYTES`           |
| Webhook request body           | —                    | 256 KiB | `PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES`   |
| Attachment upload body         | —                    | 8 MiB   | `PORKBOT_LIMIT_MAX_UPLOAD_BYTES`         |
| Open streams per actor         | actor                | 4       | `PORKBOT_LIMIT_MAX_STREAMS_PER_ACTOR`    |

An unset or blank variable takes the default; a value that is not a positive
integer fails startup rather than silently guarding with a number nobody chose.
Body caps are checked from `Content-Length` or while the body streams, so an
oversized payload is refused before it is parsed or buffered past the cap. Any
`text/event-stream` response holds a per-principal slot until it closes, errors
or the client disconnects, so one actor cannot exhaust the connection slots
another actor needs — the SSE slice inherits that without asking for it.

The anonymous budgets are keyed by the connection's remote address, never by
`X-Forwarded-For`; a process behind a proxy passes its own `clientKey` through
`createApiServer` instead of trusting a header. Limits are in process memory:
v1.0 is a single host with one API process, so a shared store would be a
dependency the topology does not need. A test walks the contract tree and fails
when a procedure has no limit, and another walks the installed routes and fails
when a route has no rule.

## Resumable streams

`threads.events` is the per-thread subscription (slice 4.3, PRD decisions 14
and 18; story 19). The durable `event` rows are the stream; the realtime fanout
is only a wake-up:

- **One subscription per thread.** The contract is `GET
/threads/{threadId}/events` with an `eventIterator` output, so the derived
  client types the frames as `RunEvent` and both web and desktop feed the same
  reducer in `packages/core`. The transport is SSE with oRPC's keep-alive
  comments.
- **The cursor is a signed position.** Every frame's SSE `id` is an
  HMAC-signed `{ actor, space, thread, seq }` minted by
  `apps/api/src/cursors.ts`; a reconnecting client sends it back as
  `Last-Event-ID`, which oRPC hands the handler as `lastEventId`. The id is
  transport metadata: `getEventMeta(event)?.id` on the client.
- **A refused cursor is typed.** A malformed, forged or foreign cursor is the
  contract's typed `BAD_REQUEST` before any frame is sent; a thread outside the
  actor's space, or one whose membership was revoked between connect and
  resume, is the same `NOT_FOUND` as a missing row. Subscribe and resume both
  re-resolve the session and the membership, and the replay loop re-reads the
  membership before every frame, so a revoked membership ends a subscription
  that is already open before another event is delivered — the client's
  reconnect is then refused with the typed `NOT_FOUND`.
- **Reconnection backs off the core way.** `subscribeThreadEvents` in
  `@porkbot/contracts` (built on `backoffDelayMs` from `@porkbot/core`) resumes
  from the last received id on a network error or 5xx/429 and rethrows a typed
  4xx rather than retrying it forever.
- **A lost signal costs a query.** The subscription subscribes to the fanout,
  re-reads `seq > cursor` from the actor-scoped repository after every wake-up,
  and re-reads after the initial replay, so a dropped signal is latency and a
  duplicate is a no-op. `InProcessRealtimeFanout` ships in `@porkbot/adapters`;
  the cross-process Postgres `LISTEN`/`NOTIFY` implementation lands in slice
  6.1 behind the same interface.

The stream holds a per-actor connection slot like any other `text/event-stream`
response (slice 4.4), and closing the connection ends the subscription, never
the run (PRD decision 25).

## Auth gate

PRD decision 7 makes authorization structure rather than discipline, and slice
3.2 is the structure: `apps/api/src/gate.ts` is the single auth gate.
`openProcedureContext()` reads the session once through `createActorResolver` in
`@porkbot/auth` (session cookie to user id, `resolveUserActor` in
`packages/db` to the membership row), and builds the actor-scoped repositories
that are the only data access a handler can reach. The context carries an
`Actor` and repositories; no contract input names a space, and a by-id read is
the repository's scoped read, so a row in another space and a row that does not
exist are the same typed `NOT_FOUND`.

Two implementers hang off one contract, so access is decided at registration:

- `authenticated` is the default. Its middleware answers the procedure's own
  typed `UNAUTHORIZED` when there is no actor and hands the handler a context
  whose `actor` and `repositories` are non-null.
- `publicOnly` is the deliberate exception and fails closed unless the contract
  marks the procedure with `publicProcedure`.

```ts
// packages/contracts/src/account.ts — an authenticated procedure
export const accountMeContract = authenticatedProcedure.route({ ... }).output( ... );

// apps/api/src/routers/account.ts — registered through the gate
const me = authenticated.account.me.handler(({ context }) => ({ ...context.actor }));
```

`packages/contracts/src/contract.ts` lists every public procedure in
`publicProcedures`, and `access.test.ts` fails when the list and the contract
drift or an authenticated procedure forgets its 401. In the API, `implement(...)`
is called only in `gate.ts`; `packages/eslint-config/auth-gate.js` fails lint for
a router that registers procedures itself, and the PR checklist asks a reviewer
to account for every public procedure. Public procedures today are exactly
`deployment.status`.

The gate's dependencies are injected: tests compose a fake session resolver and
fake repositories, and the process builds the real ones in
`apps/api/src/operator-auth.ts` from `PORKBOT_AUTH_SECRET` and
`PORKBOT_AUTH_ORIGIN` — Better Auth's handler for the mount, `createActorResolver`
for the session read, and `bootstrapSignup` for the membership a registration
gets. With those variables absent the fail-closed default stands and every
authenticated procedure is a typed 401; the composition and its signup half are
driven against a real Postgres in `apps/api/test/integration`.

## Webhook ingress

`POST /webhooks/<source>` (slice 4.5, PRD decision 24) is the deployment's only
unauthenticated write surface. It is declared as the `webhook` family in the
limits register, so it draws its own request budget and body cap; it never reads
a session and never fabricates an actor, and a handler receives provider data
only. Everything security-relevant happens in one order:

1. **The source is named correctly, known and has a secret.** A source is
   lowercase letters, digits and interior dashes, and a name outside that shape
   is refused like an unregistered one. An unregistered source or one with no
   configured secret is refused before anything else, and the answer is a flat
   401 that does not say which check failed.
2. **The signature is verified over the raw bytes, before anything parses
   them.** The ingress never decodes or parses the body at all: the handler
   receives the exact bytes the provider signed. The scheme is
   `X-Porkbot-Signature: t=<unix seconds>,v1=<hex>` where the digest is
   HMAC-SHA256 over `<t>.<raw body>`, and `X-Porkbot-Delivery` carries the
   provider's delivery id. A signature older or newer than five minutes is
   refused even when the digest is correct, and the digest comparison is
   timing-safe and tolerates a signature of any length without crashing.
3. **The delivery id is deduped.** `webhook_delivery` has a NOT NULL unique key
   over `(source, delivery_id)` and an `expires_at` a day out; every recording
   first sweeps the rows past their expiry, so the table is bounded by the
   window rather than by a scheduler. A replay inside the window is a 200 no-op
   that dispatches nothing, and two concurrent deliveries race at the index.
4. **The handler runs.** A handler failure releases the delivery row and answers
   500, so the next redelivery is dispatched instead of being deduped into a
   silent loss. A duplicate that arrives while the failing attempt is still
   running is acknowledged as a replay and is not itself dispatched; the
   provider's retry after the release is. That is what pairs with "handlers are
   idempotent by construction": at most one dispatch per delivery id while the
   row stands, and a handler that is safe to run again.

A source's signing secret is resolved through the generic `CredentialStore`
seam. With the environment store the variable is
`PORKBOT_WEBHOOK_SECRET_<SOURCE>` — derived from the operator's source name, so
no provider-specific variable exists in code. A source is registered by adding a
handler and a secret; `main.ts` currently registers none, so the route answers
401 until the connection slices own one.

The OAuth-callback half of the same surface is the `oauth_state` table: an OAuth
`state` is bound at issue time to the `UserActor` that started the flow, stored
only as its SHA-256, and consumed by one atomic
`update ... where consumed_at is null and expires_at > now()`. The first
callback wins, a replay matches no row, and an expired state cannot be consumed.
The MCP OAuth flow (slice 9.5) is the first issuer: it puts the server id in the
state's prefix and a fresh nonce after it, so a state can only complete the
server it was started for.

## MCP servers

An MCP server is installed by URL (`mcpServers.create`), discovered, granted to
bots (`mcpServers.grant`) and revoked (`mcpServers.revoke`). The seam in
`@porkbot/adapter-kit` speaks the streamable-HTTP JSON-RPC transport with OAuth
metadata and token endpoints; `McpServerEmulator` is the scripted offline server
the install, discovery and run paths are exercised against, and
`createHttpMcpServerProvider` is the real one, dialing through the URL-safety
module so a non-HTTPS URL or a private address is refused before a request is
made.

- **Installing persists before it dials.** The URL passes `assertAllowedUrl`
  first, the server row is created, the OAuth client credential is encrypted
  through the credential seam, and only then is the consent URL built. A
  discovery failure records an operator-readable status and answers the shared
  vocabulary's `SERVICE_UNAVAILABLE`; a second install of the same name is the
  typed `CONFLICT`.
- **OAuth is one-time and bound.** `servers.create` issues the state from the
  actor; the callback (`GET /oauth/mcp/callback`, no session) consumes it
  exactly once, re-resolves the initiating membership and refuses a replay, a
  foreign server or a membership that is gone with the typed `BAD_REQUEST`. The
  tokens are stored encrypted under the server's credential name and are never
  returned, echoed or listed — the contract's output schemas have no field for
  one.
- **A grant is per bot, and a revoke lands mid-run.** The run path builds its
  MCP registrations from the servers `listGrantedForBot` reports, and the tool
  layer re-reads `isGranted` before every call, so a revoke stops the next call
  of an open run rather than the next run. Tools are namespaced
  `mcp_<server>_<tool>` so two servers cannot shadow each other or a built-in,
  and every result is labelled `mcp_output` untrusted at the boundary.

The callback's absolute URL is `PORKBOT_MCP_CALLBACK_URL`; unset, the API falls
back to `http://localhost:<port>/oauth/mcp/callback` and logs a warning, because
a provider may refuse an http redirect and a local default is not a public
origin.

# Credentials never enter a sandbox (slice 7.8)

PRD decision 29; audit P1 item 7. The acceptance criteria this document
supports:

- no credential appears in a sandbox environment, file or process listing;
- the proxy only speaks to allowlisted upstream hosts for the current run;
- a credential is scoped to the run and revoked when the run ends;
- an agent cannot enumerate or read another run's credentials through any tool;
- the design is documented for the deferred screen-takeover work.

## The boundary

A run's model and provider credentials are resolved server-side — from the
encrypted credential rows through the `CredentialStore` seam — and written into
a per-computer **credential proxy**. The sandbox never holds a key. What it
holds is a capability:

- `PORKBOT_PROXY_URL` — the proxy's address on the machine's isolated network;
- `PORKBOT_PROXY_TOKEN` — an HMAC-signed token bound to one run, one computer
  and one bot, minted per command and expiring within a bounded lifetime.

A command reaches an upstream by naming it:

```
POST $PORKBOT_PROXY_URL/u/model/v1/chat/completions
X-Porkbot-Proxy-Token: <capability>
```

The proxy verifies the capability, loads the run's grant, resolves the name
(`model`) to the origin and headers the grant recorded, and forwards. The
sandbox never learns the origin, never sees the credential, and cannot name an
upstream the run's grant does not carry.

## Where the pieces live

| Concern                      | Module                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| Capability mint/verify       | `packages/effect/src/proxy-capability.ts`                                       |
| Run-scoped grant composition | `packages/effect/src/run-credential-proxy.ts`                                   |
| The proxy server itself      | `packages/adapters/src/credential-proxy.ts`                                     |
| Sidecar entrypoint           | `packages/adapters/src/proxy-main.ts`                                           |
| Docker sidecar lifecycle     | `packages/adapters/src/docker-computer.ts`                                      |
| Emulator proxy               | `packages/adapters/src/computer-emulator.ts`                                    |
| Supervisor wire routes       | `apps/supervisor/src/server.ts`, `packages/adapters/src/supervisor-computer.ts` |
| Grant revocation at run end  | `apps/worker/src/run-execution.ts`                                              |

The `CredentialProxyAdmin` seam (`grant`, `revoke`, `endpoint`) is declared in
`@porkbot/adapter-kit` and registered in `PROVIDER_INTERFACES` with two
implementations: the Docker provider's sidecar and the emulator's loopback
server.

## The trust posture

- **Capability first.** The token is verified before a grant file is read, so a
  forged or foreign token cannot learn whether a grant exists. Refusals are
  typed (`malformed`, `forged`, `expired`, `binding`) and carry no detail.
- **Per-run allowlist.** A name the grant does not carry is refused before any
  request is made. The grant's origin must be a bare HTTPS origin; a grant that
  declares plaintext, embedded credentials or a blocked address is refused when
  it is parsed _and_ re-checked through the URL-safety module on every request.
- **One egress policy.** The upstream leg is `safeFetch`, so the same blocked
  address rules and socket-level checks every other egress path enforces apply
  here; the proxy is not a second, drifting policy.
- **Header injection is narrow.** Only `accept`, `accept-language`,
  `content-type` and `user-agent` cross from the sandbox's request; the grant's
  headers are the only credential on the wire, injected after the allowlist so
  a request can never shadow them. Framing headers (`host`, `content-length`,
  `transfer-encoding`, ...) are refused at parse time and skipped at injection.
- **Bounded everything.** Request body, response body, upstream wait, grant file
  size, header count and name lengths all have caps; a refusal is a small typed
  reason and nothing else. Nothing sensitive is logged or echoed.
- **No enumeration surface.** The proxy serves one forwarding route and a
  health check. There is deliberately no list route and no grant read route, so
  one run cannot enumerate or read another's grant — the only way to use a
  grant is to present a capability that names it, and the capability is bound
  to the run and computer that minted it.

## Lifecycle

1. When a run's work starts, the worker resolves its credential plan through
   `createRunCredentialProxy` and writes one grant: run id, the run's lease end
   as a hard deadline, and the upstream set. In Docker, the supervisor writes
   the grant onto the sidecar's own layer through the daemon's archive API —
   the Docker socket holder is the only writer, the sidecar shares no mount
   with any sandbox, and a stopped machine's sidecar is removed, so the
   material does not outlive the run it was written for.
2. Each command's environment is minted fresh, sized to that command's budget,
   and revoked with the run.
3. When the run ends — completion, failure or a lost lease — the worker's
   execution harness revokes every registered grant. Revocation is a tombstone
   the proxy reads as "no grant"; the grant's own deadline is the second bound,
   so a crashed writer cannot leave a grant reachable past the run's lease.
4. A parked computer's sidecar is removed, not parked: its layer may hold a
   dead run's grant, so the next boot starts a fresh proxy with nothing in it.

## What the deferred screen-takeover work inherits

Screen watch and takeover (v1.1) present the same shape at a different door:
a short-lived capability minted by the API, bound to one computer and one
actor, verified by the supervisor without a session store
(`packages/effect/src/screen-capability.ts`, `apps/supervisor/src/server.ts`).
The rules this slice establishes transfer directly:

- the capability is the whole grant; it is never a credential and never
  carries one;
- the binding is checked against the coordinate the route already knows, and a
  valid token for another scope is a refusal rather than a replay;
- lifetimes are bounded by the minting side and capped by the codec;
- the reserved paths answer a deliberate, honest refusal until the stream
  behind them ships, rather than a socket that pretends frames are coming.

A screen capability that leaks grants an actor's view of one computer until it
expires — nothing wider — which is the same blast radius the proxy capability
has for one run's upstreams.

# The reverse proxy contract (slice 12.2, and the SPA move in 14.7)

PRD decision 32; story 4; audit P1 item 8. The acceptance criteria this
document supports:

- token streaming works through the proxy at production settings, and the
  integration suite measures inter-frame arrival rather than trusting a flag;
- response buffering is off on the stream path, asserted by the shipped config;
- a dropped connection resumes through the proxy from the signed cursor;
- the cookie policy is documented and asserted, and CORS is unnecessary because
  there is one origin;
- a misconfigured proxy is detectable from health output and this runbook.

## The boundary

One origin serves everything: the SPA, the API, the operator auth routes, file
uploads and downloads, the MCP OAuth callback, the health probes and the SSE
subscriptions. `proxy` in `deploy/compose.yaml` builds the Dockerfile's
`proxy` stage: the pinned Caddy image with the built client baked in at
`/srv/client`, running `deploy/Caddyfile`. It is the only service that
publishes a port (`80` and `443` on `PORKBOT_BIND_ADDRESS`) and the only
process that serves a byte of the SPA — there is no static host container
behind it (slice 14.7), and the API container stays on loopback, so there is
no second way in and no second origin to configure.

```
browser ── https://<PORKBOT_AUTH_ORIGIN> ──► caddy (deploy/Caddyfile)
                                              ├─ /rpc/* /api/* /files/* /oauth/*
                                              │  /webhooks/* /healthz* /livez
                                              │  /readyz
                                              │  /threads/*/attachments  ──► api:3001
                                              └─ everything else         ──► file_server
                                                                             (/srv/client
                                                                             in this image)
```

The mounts are the same five the web dev server forwards
(`apps/web/vite.config.ts`), plus the webhook ingress that providers call
directly (a browser never does, which is why the dev proxy does not forward it)
and the health paths so `/healthz`, `/livez` and `/readyz` answer from the API
rather than the SPA's file server.

## What the file server guarantees

The SPA's half of the config is three rules over `/srv/client`, in the order
`src/host.ts` served the artifact when a Node process still did:

| Concern            | In `deploy/Caddyfile`                                                       | Why it matters                                                                                               |
| ------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Deep-link fallback | `not path_regexp \.[^/]+$` → `rewrite /_shell.html`                         | An extension-less path is a client route and gets the shell so the router resolves it.                       |
| A missing asset    | the `respond 404` fallback, never the shell                                 | A broken bundle reference must be a 404, not a blank page with a 200.                                        |
| Hashed assets      | `header Cache-Control "public, max-age=31536000, immutable"` on `/assets/*` | The bundle is content-addressed; a year of immutable caching is safe and keeps a reload off the network.     |
| The document       | `header Cache-Control "no-cache"` for the shell and any served file         | The document is the release: a cached shell pins stale asset URLs and an operator would run last week's app. |

The two cache policies are asserted against the real image in the
`apps/api` integration suite and against the real built artifact in
`apps/web`'s e2e, so the difference is a measured behaviour rather than a
comment.

## What the shipped config guarantees

| Concern          | In `deploy/Caddyfile`                            | Why it matters                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buffering        | `flush_interval -1` on the API route             | Caddy already flushes `text/event-stream` responses immediately; the directive makes the guarantee explicit, and a positive value or `response_buffers` would silently break it. There is no `encode` on this listener either — compression buffers. |
| Reads            | `read_header 10s`, `read_body 5m`, `idle 5m`     | A slow request is refused before it reaches the API, and an idle keep-alive connection is closed.                                                                                                                                                    |
| Upstream wait    | `dial_timeout 5s`, `response_header_timeout 30s` | A dead API answers 502/504 instead of holding sockets; the wait covers the response headers only, never the stream.                                                                                                                                  |
| No write timeout | deliberately absent                              | A server `write` timeout bounds a whole response, and a token stream is expected to stay open.                                                                                                                                                       |
| `Last-Event-ID`  | no header directive                              | Caddy passes request headers through untouched; the API is the only thing that validates the cursor, and a reconnect resumes instead of refetching.                                                                                                  |
| Cookies          | no header directive                              | `Set-Cookie` and `Cookie` cross unchanged; the auth layer owns the attributes.                                                                                                                                                                       |

## The cookie policy

- **One origin, so no CORS.** The API emits no `Access-Control-Allow-*` header
  and needs none; the browser's origin and the API's origin are the same, and
  the integration suite asserts the proxy does not invent a grant.
- **The origin sits on the proxy's published ports.** `deploy:check` refuses
  an origin that names a port, because the proxy publishes 80 and 443 and a
  Caddy site bound to anything else inside the container would be unreachable.
- **SameSite=Lax, HttpOnly, Path=/.** `packages/auth/src/config.ts` holds the
  attributes; `createAuth` applies them to every cookie Better Auth sets.
- **Secure on an https origin.** `createOperatorAuth` marks cookies `Secure`
  when `PORKBOT_AUTH_ORIGIN` is https, which `deploy:check` requires outside
  loopback. An http origin is a session leak the deployment refuses to render.
- **CSRF is the library's origin and Fetch Metadata checks**, with
  `trustedOrigins` pinned to the one origin; the proxy widens neither.
- **The session cookie's name** is `porkbot.session_token` (or
  `__Secure-porkbot.session_token` under the secure prefix). Nothing else in
  the stack reads or writes it.

## Readiness and the streaming probe

Two probe paths make a broken proxy visible without a browser:

- `GET /healthz` — the API answers `{ status: "ok", service }`. The proxy's
  own container healthcheck asks a loopback listener
  (`http://127.0.0.1:8899/healthz`) that answers only when the config loaded
  and the API route in it works, so `pnpm deploy:status` shows a broken
  proxy-to-API path as `unhealthy`.
- `GET /healthz/stream` — a `text/event-stream` probe that emits three numbered
  frames 250 ms apart and honours `Last-Event-ID`. It carries no product data,
  draws the probe rate-limit budget, and exists so the buffering failure has a
  one-command test. Being an SSE response, it also holds one of the anonymous
  stream slots (one by default), so run probes one at a time; a 429 on the
  probe is the limiter, not buffering.

## Runbook: when streaming does not stream

Symptom: tokens arrive all at once after a pause, a stream dies at a fixed
interval, or a reconnect replays from the beginning.

```sh
# 1. Is the API answering through the proxy at all?
curl -fsS https://bots.example.com/healthz

# 2. Is the stream path buffered? Frames must appear one at a time, ~250 ms
#    apart; arriving together after a pause means something is buffering.
curl -N https://bots.example.com/healthz/stream

# 3. Is Last-Event-ID preserved? This must return frames 2 and 3 only.
curl -N -H 'Last-Event-ID: 1' https://bots.example.com/healthz/stream

# 4. What does the deployment think?
pnpm deploy:status      # proxy must be healthy
pnpm deploy:logs proxy  # config load errors, TLS failures
pnpm deploy:logs api    # the API's own view
```

| What you see                           | Where to look                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frames arrive together                 | `flush_interval -1` missing or a positive value in `deploy/Caddyfile`, `response_buffers` set, or an `encode` rule; if the config is right, a second proxy or load balancer is buffering in front. |
| The stream dies after a fixed interval | A read/write timeout below the layer, on the proxy or on network gear; this config has no `write` timeout on purpose.                                                                              |
| A reconnect replays or skips events    | Something rewrote or dropped `Last-Event-ID`; this config has no header rules on the stream path.                                                                                                  |
| 502/504 from the proxy                 | The API is down or unreachable: `pnpm deploy:status`, then `pnpm deploy:logs api`.                                                                                                                 |
| The proxy is `unhealthy`               | Its loopback probe could not reach the API route: check the config mount, the compose network and the API's health.                                                                                |
| Login loops or the cookie is missing   | `PORKBOT_AUTH_ORIGIN` differs from the browser's origin, or the origin is http where the cookie is `Secure`.                                                                                       |
| No certificate yet                     | DNS does not point at the host, or `PORKBOT_BIND_ADDRESS` is still loopback. Caddy retries; `pnpm deploy:logs proxy`.                                                                              |

The integration suite (`apps/api/test/integration/reverse-proxy.integration.test.ts`)
runs this exact config against the pinned image on every CI run, so a config
edit that breaks one of these behaviours fails a test before it reaches a host.

## What this deployment does not promise

- **A load balancer or CDN in front is out of scope.** The contract holds for
  the shipped Caddy; another hop that buffers is that hop's configuration.
- **Anonymous rate-limit budgets are shared behind the proxy.** The API keys
  unauthenticated budgets on the socket address and never trusts
  `X-Forwarded-For`; through the proxy that address is Caddy's. For a
  single-operator v1.0 deployment the operator is the anonymous traffic;
  authenticated calls key on the actor and are unaffected. A multi-tenant
  deployment needs a trusted-proxy address policy, which is a deliberate
  later change rather than a header the API reads today.
- **`deploy:down --volumes` deletes the certificate store** along with Postgres
  data and bot storage; Caddy obtains certificates again on the next boot.

## Where the pieces live

| Concern                   | Module                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| The shipped config        | `deploy/Caddyfile`                                                                                                        |
| The proxy image           | the Dockerfile's `proxy` stage (Caddy + `apps/web/dist/client` at `/srv/client`)                                          |
| The proxy service         | `deploy/compose.yaml`, `compose.yaml` (local shape)                                                                       |
| The streaming probe       | `packages/health/src/index.ts`, mounted in `apps/api/src/app.ts`                                                          |
| The route register        | `apps/api/src/limits.ts` (`probe` family)                                                                                 |
| The suite that drives it  | `apps/api/test/integration/reverse-proxy.integration.test.ts`, `startCaddyProxy` in `packages/testkit/src/proxy/caddy.ts` |
| The SPA through the proxy | `apps/web/test/e2e/static-build.e2e.test.ts`                                                                              |
| The config assertions     | `packages/testkit/test/deployment.test.ts`                                                                                |
| Cookie attributes         | `packages/auth/src/config.ts`, `apps/api/src/operator-auth.ts`                                                            |

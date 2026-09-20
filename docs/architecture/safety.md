# Safety seams

## Provider seams

`packages/adapter-kit` declares one interface per external capability — mail,
credentials, computers, the model runtime, memory, MCP servers, notifications,
realtime fanout, storage and web access — plus the shared failure vocabulary (`gone`,
`not_found`, `rate_limited`, `timed_out`, `auth_failed`) that every adapter
translates its own errors into. It ships no implementation and imports no vendor
SDK; implementations and their offline emulators live in `packages/adapters`,
and lifecycle code branches on the failure kind rather than on a provider's
error string.

Every declared interface names at least two planned implementations, each pinned
to the roadmap slice that lands it, in `PROVIDER_INTERFACES` in
`packages/adapter-kit/src/provider-plan.ts`, and carries a failure mapping that
documents every kind in the vocabulary. `provider-plan.test.ts` fails when a
declared interface is missing from the register or the shapes list, carries
fewer than two implementations, or leaves a failure kind undocumented, so "an
interface with one implementation is a hypothesis" is a check rather than a
convention.

## URL safety

Every fetch of a user-supplied URL — an MCP server, an OpenAPI document, a model
endpoint, a web page — goes through `@porkbot/effect`'s `safeFetch` (PRD decision
23). It enforces HTTPS, refuses embedded credentials, and blocks private,
loopback, link-local, metadata, multicast and reserved addresses.

The rules are one list, `BLOCKED_ADDRESS_RULES`, and the check that matters runs
as the socket's DNS lookup rather than as a pre-flight string check: every
connection resolves and checks again, so a hostname that answers with a public
address for one look and a private one for the next is refused on the socket.
An IP-literal host never reaches the resolver, so `assertAllowedUrl` checks it
where it is parsed. A refused fetch throws a typed `BlockedUrlError` — never a
raw network failure — and a test in `packages/effect` walks the shipped fetch
call sites, so a new one cannot bypass the module.

## Untrusted content

The product's core risk is an agent reading the web, a file, an email or a tool
result that carries instructions. `packages/core/src/ingestion.ts` is the one
vocabulary for that boundary: `INGESTION_PATHS` lists the ways content enters
(web fetch, file read, email, MCP output, computer output), and the module that received the
content calls `labelUntrustedContent` with its path, its origin and the text,
producing an `UntrustedContent` whose `label` is the literal `"untrusted"`. An
unregistered path, a blank origin or a non-string payload throws, so content is
never labelled by assumption. `composeRunPrompt` renders every ingested value as
a `data`-channel section under its provenance line, and the composer wraps that
channel in the data notice — a directive inside a page is reference material the
model is told not to obey, never an instruction.

The machine's half of that boundary lands with slice 6.9: `file_read` labels
the bytes a file tool returns with the path it asked for, and `computer_output`
labels shell stdout, directory listings and browser page text with the machine
or the page they came from. The shell is deliberately on the register too,
because a shell can read a file the dedicated tool would have labelled and the
trust boundary must not depend on which tool the model chose.

The web path ships end to end (slice 10.1). `WebAccessEmulator` is the
deterministic scripted web the product runs on with nothing configured, and
`createHttpWebAccessProvider` dials every page through the URL-safety module's
`safeFetch` by default, reads the body under a byte budget and classifies
refusals with the shared failure vocabulary; both run one conformance suite. The
model's tools are `createWebTools` in `@porkbot/effect`: `web_fetch` asks the
run's egress guard first and returns the page labelled untrusted with its final
URL, and `web_search` returns labelled titles and snippets with the query's
limit clamped.

Egress is allowlisted per run. `parseEgressAllowlist` accepts hosts and
`*.domain` wildcards and refuses a scheme, a port, a path or a credential; an
empty list is fail-closed. `decideEgress` answers allowed, needs-approval or
refused on the host alone — the blocked address ranges stay in the URL-safety
module's one list — and `createEgressGuard` turns needs-approval into a durable
row in the run's approval gate: an allowlisted host proceeds with no write, any
other destination records the pending request before a packet is sent, and an
operator decision or the deadline settles it, a timeout denying rather than
hanging.

The adversarial fixtures for the injection-resistance suite (slice 10.4) live in
`packages/adapters/src/ingestion-fixtures.ts`, one per registered path, each
carrying the marker a pass must never observe. A call-site suite in
`packages/core/src/ingestion.call-sites.test.ts` walks the shipped tree and fails
a module that touches a registered boundary without labelling, and the fixtures
suite fails a registered path with no fixture, so a new ingestion surface cannot
slip past either check.

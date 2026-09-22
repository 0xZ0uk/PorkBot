# Clients

## Web shell

`apps/web` is the product's client: TanStack Start in static SPA mode
(`spa.enabled` in `vite.config.ts`), so the build prerenders one `_shell.html`
and the router boots from it. `pnpm build` emits `dist/client` — HTML, JS and
CSS — and no SSR process is required at run time. The same directory is what
the `web` image serves and what the Electron wrapper packages (slice 11.6), so
there is one client build and no fork. The app's own server
(`apps/web/src/host.ts`) is a file server with the SPA contract: an existing
file is streamed with its content type, an extension-less path with no file
answers the shell and lets the router resolve it, a missing asset stays a 404,
`/livez` answers process liveness, `/readyz` checks that the shell exists, and a
path that escapes the root is refused rather than answered with the shell.

Auth has three states, not two. `createSessionController` resolves the session
through `account.me` — the contract's first authenticated procedure — and the
`bootstrapping`, `signed-out`, `signed-in` and `unavailable` states are what the
route guards branch on, so a session read that failed shows a "can't reach the
server" screen with one retry instead of a sign-in form that cannot work. The
credential exchange posts to Better Auth's routes under `/api/auth` (slice 12.1
mounts the handler), the session cookie stays `HttpOnly` and JavaScript never
reads it, and `deployment.status` decides whether sign-in offers registration.

Colour and type come from `@porkbot/tokens`, which holds PorkBot's own palette
— monochrome surfaces, one warm accent, the state colours and a twelve-position
identity ramp — in its light and dark modes. `themeStyleSheet` turns the palette
and the scales into `--pb-*` custom properties and the shadcn semantic set,
declares light on `:root` and dark behind `prefers-color-scheme`, and repeats
both as `[data-theme]` rules so a stored choice wins over the system;
`themeBootstrapScript` applies that choice before the bundle runs. The web app
builds its CSS through `@tailwindcss/vite` from a `globals.css` whose
`@theme inline` block maps those variables into the Tailwind theme, so a
surface writes `bg-background` and gets `var(--background)`. and `apps/web`'s `theme.ts` appends the shell's document
rules. Inter and JetBrains Mono are self-hosted through the
bundle, so the desktop's offline build needs no network for type. The surfaces
and stylesheet name only those properties, and the lint rule in
`@porkbot/eslint-config` fails a hardcoded colour — hex, `rgb()`, `hsl()` or
`oklch()` — in `@porkbot/web`, so a theme change stays one file. The screens
are labelled and keyboard-reachable: labels
bind to inputs, the refusal is a `role="alert"` that takes focus, and a skip
link leads to the focused `#main`. The e2e tier builds the artifact, serves it
through the shipped reverse proxy and asserts the shell's asset references
exist, the bootstrapping state is in the prerendered HTML, and a deep-linked
client route is rewritten to the shell rather than 404ed
(`static-build.e2e.test.ts`), mounts the thread
console over a real HTTP connection to a scripted oRPC/SSE server to prove the
resume path (`thread-console.e2e.test.ts`), mounts the memory screen over a
scripted memory API to prove a correction survives a reload
(`memory.e2e.test.ts`), and mounts the connections screen over a scripted
connections API to prove a create, a revoke and a probe through the real wire
(`connections.e2e.test.ts`). The API package's Playwright spec adds the
release-level browser pass against that built artifact and the real API,
including approval, steering, stop and durable reload replay, with the
provider seams held by offline emulators.

## Thread console

Slice 6.6 is the product's first real screen: `apps/web/src/console.ts` is the
console's state machine, `use-console.ts` is its React binding, and
`routes/_app/threads.$threadId.tsx` is its route. The console owns one thread's
subscription, folds every frame through the reducer in `packages/core`, and
publishes one state the screen renders — the reducer is the only interpretation
of the stream and the screen is a pure function of the state.

- **Tokens render as they stream.** A `token.delta` extends the assistant
  message in place; the client never waits for `run.completed`.
- **Reload is a replay, not a client-held cursor.** A reload starts a fresh
  snapshot at seq 0; the durable rows are the stream, so the server replays
  every event and the reducer rebuilds the snapshot the wire would have
  produced. The signed cursor still resumes a dropped socket inside one
  connection, where `subscribeThreadEvents` owns the backoff.
- **Connection state is visible without noise.** `subscribeThreadEvents`
  reports `connecting`, `live`, `reconnecting` and `resumed`; the screen shows
  one polite status line for the phases that are not plainly live, and no
  chrome while frames are flowing.
- **The transcript is the order, the reducer is the content.**
  `threads.messages` carries the user turns and the message sequence — the send
  that started a run is a row, not a run event — and each message renders the
  reducer's text for its id, so a partial assistant message and its closed text
  are the same element. The transcript is read once per console start, walking
  the contract's forward pages to the newest turn (bounded at ten pages), so a
  run-starting message written in another tab arrives on the next mount while a
  steering message arrives as an event.
- **A refusal is a state with a retry.** A typed `NOT_FOUND` says the thread is
  not available; any other failure says the stream could not be read; either
  offers one retry that restarts from zero.

The home screen is the smallest entry point that makes the console reachable —
the actor's bots, their recent threads and a New thread button — and the bot
editor and sections (slice 11.2) replace it.

The e2e tier mounts the console in a DOM over a real HTTP connection to a
scripted oRPC/SSE server and proves the resume-path criteria: tokens before
completion, a reload replaying to the same snapshot, and a dropped connection
reconnecting from its signed cursor with `Reconnecting…` becoming `Resumed`.

## Desktop releases

`apps/desktop` ships as one artifact per platform, and a release is a tag, a
GitHub Release that is never overwritten, and a signed `update-<platform>-<arch>.json`
whose digest names the artifact's exact bytes. The `desktop` CI tier runs the
same pipeline on every pull request — package for linux-x64, sign with a
throwaway key, verify, then start the packaged app under Xvfb against a real
API process on loopback until the sign-in screen renders — and the `Release`
workflow does it for real from a manual dispatch. No step needs a maintainer's
machine. The full runbook is in [`docs/release.md`](../release.md).

```sh
pnpm release:bump patch           # in a pull request: 0.0.0 -> 0.0.1
pnpm desktop:package -- --targets linux-x64 --out .release
pnpm desktop:smoke -- --app .release/PorkBot-linux-x64/PorkBot \
  --server-url http://127.0.0.1:3001
```

(The `--` before a script's flags keeps pnpm from reading them as its own;
`pnpm release:bump patch` needs none because the bump keyword is positional.)

- **One command per step.** `packages/testkit/src/release/cli.ts` is the whole
  pipeline: `bump` writes the version, `package` stages the production
  dependency closure and the web client with @electron/packager, `sign` signs
  each artifact's SHA-512 into the manifest the app verifies, `verify` re-hashes
  every artifact and checks every signature against the pinned public key, and
  `smoke` drives the packaged app's own first-run flow through the Chrome
  DevTools Protocol. The artifact name carries the version, the platform and
  the git commit (`PorkBot-0.2.0-linux-x64-3f9c2a1b0d4e.tar.gz`), and
  `build-manifest.json` records the full commit, the Electron version and every
  digest.
- **The key is a deployment secret.** `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` (a
  GitHub Actions secret) signs; the public half is the value the app pins as
  `PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY`. The workflow refuses to publish without
  them, and the desktop's own suite fails if the release's canonical signing
  bytes and the app's verified bytes drift apart.
- **OS code signing is the operator's.** The Ed25519 manifest is the trust
  boundary the app enforces; Apple notarization and Windows Authenticode are
  deployment certificates the project does not hold, so the macOS and Windows
  artifacts are unsigned by the OS and a downloading operator decides whether
  to trust the publisher. Linux artifacts run as extracted.

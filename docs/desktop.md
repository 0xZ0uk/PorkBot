# The desktop app

`apps/desktop` is the Electron shell for PorkBot. It is **connect-only**: it
hosts the same web build the deployment serves and dials the operator's server.
It runs no supervisor, no computer and no worker on the operator's machine, and
it is never handed a server credential of its own — the session cookie belongs
to the window, exactly as it does in a browser.

The "run here" topology — a supervisor and computers on the operator's laptop,
driven from the desktop app — is **deferred to v1.1** (issue #180, PRD open
question 1). It is absent from this slice on purpose: the supervisor's lifecycle
ownership (slice 7.1) assumes a process that owns the Docker socket, and moving
that into a desktop process needs the local-Docker detection and privilege story
that issue #180 carries. Nothing in this app starts a computer.

## One client build, one host contract

`pnpm build` writes `apps/web/dist/client`; the desktop packages that directory
as `client` beside the app's resources (`resolveClientRoot` in
`apps/desktop/src/client-root.ts`). A development run reads the same directory
where `pnpm build` wrote it, so a dev run and a packaged run load the same
bytes.

The window cannot load the SPA from one origin and call the API on another: the
session cookie is `HttpOnly` and scoped to the server, and the API is built for
a single TLS origin (PRD decision 32). So the main process runs a loopback
server (`src/proxy.ts`) that:

- serves the packaged build through the **same static handler** the `web` image
  runs (`createStaticHandler` in `@porkbot/web`), including the SPA rewrite and
  the path-traversal refusal;
- forwards `/rpc` and `/rpc/*` and `/api/*` to the configured server, streaming
  request and response bodies so `text/event-stream` arrives frame by frame and
  `Last-Event-ID` survives a resume;
- rewrites `Set-Cookie` onto the loopback origin (drops `Domain` and `Secure`,
  forces `Path=/` and `SameSite=Lax`), so the cookie the server issued is the
  cookie the renderer carries on the next request;
- sets the origin header to the server's, so the API's CSRF and trusted-origin
  checks see what a same-origin browser request would look like.

The renderer sees one same-origin app, and no screen, transport or cookie rule
is re-implemented. The static handler's `document` seam exists for this app: it
is where the shell gets a fresh content-security nonce.

## Hardening

The window flags live in one table, `HARDENED_WEB_PREFERENCES` in
`src/hardening.ts`, and `main.ts` builds every window through
`hardenWebPreferences` and `assertHardened`. `src/hardening.test.ts` walks the
shipped tree and fails a `BrowserWindow` constructed anywhere else, a relaxed
flag named outside the table, or a preload channel literal that disagrees with
the main process.

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` (and the
  worker and sub-frame variants), `webSecurity: true`,
  `allowRunningInsecureContent: false`, `experimentalFeatures: false`,
  `webviewTag: false`, `navigateOnDragDrop: false`.
- The renderer's only bridge is `window.porkbot.forwardRunEvent`, exposed by the
  sandboxed preload (`src/preload.cts`); there is no Node, no filesystem and no
  other channel.
- The **content security policy is nonce-based**. Every HTML document the proxy
  serves gets a fresh nonce stamped onto its inline scripts and styles and named
  in `script-src`/`style-src` (`applyContentSecurityNonce`,
  `contentSecurityPolicyFor`). Hashes cannot work here: the shell's hydration
  stream contains a raw NUL that the HTML parser rewrites to U+FFFD, so the
  parser's script text is not the file's text. `'unsafe-inline'` is never
  emitted.
- Navigation is decided by `src/navigation.ts`: the app's own origin is allowed,
  an `https:` link opens in the system browser, a frame may not embed a foreign
  document, and everything else is refused.
- Permissions are denied by default; only `clipboard-sanitized-write` and
  `fullscreen` are answered yes.

## Tray and notifications

The tray (`src/tray.ts`) carries the actions a web surface cannot: show/hide,
change the server, check for updates, quit. The tooltip counts the runs the app
has seen in flight.

Runs are observed where they are already reduced: the web console hands every
accepted frame to `forwardRunEvent` (`apps/web/src/desktop.ts`), which forwards
the run's lifecycle frames across the preload bridge. The desktop turns a
terminal frame into a native notification (`src/run-notifications.ts`): a
completion says a run finished, a failure carries the run's own error sentence
(clipped), and a cancellation — the operator's own act — says nothing. The
notification is shown when the window is not focused, and clicking it focuses
the window.

This is the local, OS-governed channel. The server's notification preferences
(slice 8.6) govern the durable delivery adapters, not whether an open window
tells the operator what happened.

## Signed updates

An update is refused unless it verifies. The release publishes an
`update.json` under the configured feed:

```json
{
  "version": "0.2.0",
  "url": "https://updates.example.com/PorkBot-0.2.0.AppImage",
  "sha512": "<base64 SHA-512 of the artifact>",
  "signature": "<base64 Ed25519 signature over the payload>"
}
```

The signed payload is the three fields joined by newlines, in order:
`version`, `url`, `sha512`. Sign it with the release's Ed25519 private key:

```sh
openssl pkeyutl -sign -inkey release.pem -rawin -in payload.txt | base64 -w0
```

The app pins the public key (`PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY`, base64 SPKI
DER or PEM) and the feed base URL (`PORKBOT_DESKTOP_UPDATE_FEED`, HTTPS only).
`src/update-controller.ts` is the only code that fetches or writes an update:
it reads the feed, parses the manifest, verifies the signature, refuses a
version that is not newer, downloads the artifact, verifies its bytes against
the signed digest, and only then stages it on disk. An unsigned, mis-signed,
tampered, non-HTTPS or unreachable update never reaches the file system — the
tests drive each of those through the same door and assert nothing was written.
A build with no feed configured reports `not_configured` and checks nothing.

The operator is asked before a verified artifact is opened with the OS handler;
silent install-and-relaunch is not part of the self-hosted build.

## Running it

```sh
pnpm build
pnpm --filter @porkbot/desktop start     # downloads the Electron runtime on first use
```

The first run opens the setup page, which asks for the server address and
stores it in Electron's `userData` directory (`desktop-settings.json`). The tray
can reopen it to change servers. Plain HTTP is accepted only for loopback
addresses, where the developer runs the stack on the same machine.

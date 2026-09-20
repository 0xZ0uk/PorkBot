# Releasing the desktop app

A desktop release is a git tag (`desktop-v<version>`), one artifact per
platform, a signed update manifest per artifact, and a GitHub Release that is
never overwritten. The pipeline is `packages/testkit/src/release/cli.ts`, the
tagged run is `.github/workflows/release.yml`, and the same commands run inside
the `desktop` CI tier on every pull request. Nothing in the process needs a
maintainer's machine: the one manual act is dispatching the workflow after the
version bump is merged.

## What an artifact is

`PorkBot-<version>-<platform>-<arch>-<commit>.tar.gz`, where `<commit>` is the
first twelve characters of the git SHA the build was taken from. Inside is the
Electron app: the compiled shell in `resources/app.asar`, the packaged web
client in `resources/client`, and the production dependency closure. The
release also carries:

- `build-manifest.json` — the schema version, the app name, the version, the
  full 40-character commit, the Electron version, the build time, and every
  artifact's file name, byte size and base64 SHA-512.
- `update-<platform>-<arch>.json` — the signed update manifest:
  `{ version, url, sha512, signature }`. The URL points at the GitHub Release
  asset; the signature is Ed25519 over the three fields joined by newlines, in
  that order; the app refuses anything that does not verify against its pinned
  public key, or whose downloaded bytes do not hash to `sha512`.
- `checksums.txt` — each artifact's SHA-512 in hex on the `sha512sum -c` shape,
  so a download can be checked with the system tool. The manifests keep base64,
  because that is the encoding the signature covers.
- `RELEASE_NOTES.md` — generated from the commit log since the previous
  `desktop-v*` tag, grouped by conventional-commit type.

The filename carries the commit and the manifest records it in full, so an
artifact and its revision cannot be separated; the digest is signed, so the
artifact cannot be replaced under the same manifest. A tag or release that
already exists is never overwritten — re-running the workflow fails rather than
re-publishing.

## Bumping the version

The version lives in `apps/desktop/package.json`, and it is the release's
identity: the workflow refuses to build unless the manifest already declares
the input version. Bump it in a pull request, never at release time:

```sh
pnpm release:bump patch        # 0.2.3 -> 0.2.4
pnpm release:bump minor        # 0.2.3 -> 0.3.0
pnpm release:bump major        # 0.2.3 -> 1.0.0
pnpm release:bump 0.4.0        # explicit; must move forward
```

Commit the change, get the pull request merged, and remember that the `desktop`
tier packages the new version and smokes it like any other change.

## One-time key setup

The release key is a deployment secret. Generate an Ed25519 pair once:

```sh
openssl genpkey -algorithm ed25519 -out release-key.pem
openssl pkey -in release-key.pem -pubout
```

Then, in the repository settings:

- **Secret** `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` — the contents of
  `release-key.pem`. The signing step refuses to run without it, so an
  unsigned release cannot be produced by accident.
- **Variable** `PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY` — the printed public half.
  The verification step checks every signature against it, and it is the value
  the desktop app pins. Keep the private key wherever the deployment keeps its
  secrets; it never enters the repository, a log line or an artifact.

## Publishing a release

Run the `Release` workflow (Actions → Release → Run workflow) with the version
that is already merged. A dry run is the default: it builds, signs, verifies,
generates the notes and uploads everything as workflow artifacts without
touching the repository. Turn `dry_run` off to create the tag and the GitHub
Release at the dispatched commit.

The workflow:

1. refuses a version the manifest does not declare, and a tag that exists;
2. builds the workspace and packages linux-x64, darwin-arm64 and win32-x64;
3. signs each artifact's SHA-512 into its update manifest;
4. re-hashes every artifact and verifies every manifest against the pinned key;
5. generates the notes from `desktop-v*` to the dispatched commit;
6. creates `desktop-v<version>` at the checked-out commit and uploads every
   artifact, manifest and checksum file.

## Verifying a release

The app does this itself on every update check: it fetches the feed's
`update.json`, verifies the signature against `PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY`,
refuses a version that is not newer, downloads the artifact, and verifies its
bytes against the signed digest before staging it. An operator can run the same
check by hand:

```sh
node packages/testkit/src/release/cli.ts verify \
  --out .release --public-key-file release-key.pub
```

Releases published from this repository carry `update-<platform>-<arch>.json`
per platform because each platform is a different artifact. Point a deployment's
`PORKBOT_DESKTOP_UPDATE_FEED` at the directory that serves the manifest for the
platform the operator runs, renamed to `update.json`.

## Running the pipeline locally

```sh
pnpm build
node packages/testkit/src/release/cli.ts package --targets linux-x64 --out .release

openssl genpkey -algorithm ed25519 -out /tmp/release-key.pem
openssl pkey -in /tmp/release-key.pem -pubout -out /tmp/release-key.pub
PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY="$(cat /tmp/release-key.pem)" \
  node packages/testkit/src/release/cli.ts sign \
    --tag desktop-v0.0.0 --repo <owner>/<name>
node packages/testkit/src/release/cli.ts verify --public-key-file /tmp/release-key.pub

node packages/testkit/src/release/cli.ts notes --version 0.0.0
```

The smoke test starts the packaged executable and walks its first-run flow
through the Chrome DevTools Protocol: the setup screen appears, the server
address is entered and submitted through the page's own form, and the sign-in
screen renders — which can only happen if the packaged web client loaded and an
RPC call crossed the proxy to a running server. Give it one:

```sh
# Any running PorkBot API works; a development checkout runs this way.
PORT=3199 DATABASE_URL="postgres://porkbot:placeholder@127.0.0.1:5432/porkbot" \
  PORKBOT_STORAGE_DIR=/tmp/porkbot-desktop-storage node apps/api/src/main.ts &

xvfb-run --auto-servernum node packages/testkit/src/release/cli.ts smoke \
  --app .release/PorkBot-linux-x64/PorkBot \
  --server-url http://127.0.0.1:3199
```

The smoke's server only needs the pre-auth paths, so the placeholder database
is never dialled; on a machine with a display the `xvfb-run` wrapper is
optional. Under the CI tier the app is started with `--no-sandbox` and a
throwaway `XDG_CONFIG_HOME`, because the sandbox helper needs a setuid binary
the runner cannot install and a smoke run must never touch a real installation's
settings.

## Platform notes

- Linux is the platform the smoke test runs, so it is the one whose artifact is
  proven to start on every pull request.
- macOS and Windows artifacts are packaged but not code-signed by the OS: Apple
  notarization and Authenticode need certificates this project does not hold.
  The signature the app actually verifies is the Ed25519 update manifest, which
  is platform-independent. An operator who wants OS-level signing builds from
  a tag and signs with their own certificate.
- Packaging macOS and Windows from Linux is @electron/packager's supported
  cross-packaging; nothing platform-specific is compiled here.

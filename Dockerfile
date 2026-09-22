# syntax=docker/dockerfile:1

# The whole workspace is installed and built once, then each app is deployed
# with `pnpm deploy --prod` into its own runtime image. Compose builds the target
# a service names (compose.yaml), so `pnpm stack:up` pays for one install and one
# build, and every service image carries the app and its workspace dependencies
# rather than the toolchain.
#
# The base image carries the exact Node version from .nvmrc — pnpm's devEngines
# check refuses anything else — and is pinned by digest, so the stack builds
# from the image dependencies.json registers. It is the glibc flavor on
# purpose. Issue #253's smaller-base trial (alpine) is stopped on a named
# dependency rather than worked around: the Docker computer provider
# classifies a killed command as `timed_out` from the `timeout` binary's exit
# code 124, which is GNU coreutils behaviour (BusyBox `timeout` exits 143), so
# a musl machine image turns every budget overrun into an ordinary result (see
# the seam in packages/adapters/src/docker-computer.ts and its conformance
# suite). The base swap returns only when that seam stops reading userland
# exit codes.

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV CI=1
ENV TURBO_TELEMETRY_DISABLED=1

RUN corepack enable

WORKDIR /repo

# Manifests and config first, then the workspace sources. This mirrors the
# build graph: the lockfile and tsconfigs change rarely, the apps change often.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json .npmrc .nvmrc quarantine.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm build

# `--legacy` because the workspace does not set inject-workspace-packages; the
# deployed directory still carries the workspace packages it imports.
RUN pnpm deploy --filter @porkbot/api --prod --legacy /deploy/api
RUN pnpm deploy --filter @porkbot/worker --prod --legacy /deploy/worker
RUN pnpm deploy --filter @porkbot/supervisor --prod --legacy /deploy/supervisor
RUN pnpm deploy --filter @porkbot/backup --prod --legacy /deploy/backup

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS api

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/api ./
# The avatar storage root (PORKBOT_STORAGE_DIR in compose) exists in the image
# owned by the runtime user, so a fresh named volume inherits a writable mount.
RUN mkdir -p /var/lib/porkbot/storage && chown -R node:node /var/lib/porkbot
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]

# The one-shot migration runner. It carries the same deployed workspace as the
# api — `@porkbot/db` and its committed migrations — and runs once per stack:
# apply the journal, create the two service roles' grants (the migration) and
# set their passwords from the environment (the command). The api and the worker
# wait for it with `service_completed_successfully`, so an always-on process
# never starts against an unmigrated database.
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS migrate

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/api ./
USER node
CMD ["node", "node_modules/@porkbot/db/dist/migrate-cli.js"]

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS worker

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/worker ./
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]

# The reverse proxy and the SPA in one image (slice 14.7): Caddy serves the
# built client from /srv/client — the root deploy/Caddyfile names — so the
# static host process and its image disappear and the deep-link fallback and
# the asset cache headers live in the shipped config instead. The base is the
# same pinned Caddy the register records and the integration suite boots.
FROM caddy:2.11.4-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e AS proxy

COPY --from=build /repo/apps/web/dist/client /srv/client

# Only the two client binaries `pg_dump` and `pg_restore` spawn need leave this
# stage — not the Postgres server. They must be the server's own major (a
# client older than its server refuses to dump it) and the server's own ABI:
# the pinned Postgres image is Debian trixie, and a glibc runs forwards, not
# backwards, so its clients cannot run on the bookworm base the other services
# use. The backup image therefore sits on the slim Node build of the same
# Debian release — one Node runtime, no server — and the shared libraries
# below are the binaries' load-time closure minus what that image already
# carries (libz, libzstd and liblz4).
FROM postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280 AS pg-client

FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS backup

COPY --from=pg-client /usr/lib/postgresql/18/bin/pg_dump /usr/lib/postgresql/18/bin/pg_restore /usr/local/bin/
COPY --from=pg-client /lib/x86_64-linux-gnu/libpq.so.5* /lib/x86_64-linux-gnu/libssl.so.3* /lib/x86_64-linux-gnu/libcrypto.so.3* /lib/x86_64-linux-gnu/libgssapi_krb5.so.2* /lib/x86_64-linux-gnu/libkrb5.so.3* /lib/x86_64-linux-gnu/libk5crypto.so.3* /lib/x86_64-linux-gnu/libkrb5support.so.0* /lib/x86_64-linux-gnu/libcom_err.so.2* /lib/x86_64-linux-gnu/libldap.so.2* /lib/x86_64-linux-gnu/liblber.so.2* /lib/x86_64-linux-gnu/libxxhash.so.0* /lib/x86_64-linux-gnu/libsasl2.so.2* /lib/x86_64-linux-gnu/libkeyutils.so.1* /lib/x86_64-linux-gnu/
# The load check: a client whose shared libraries are not all present fails
# the build here rather than on the first nightly backup.
RUN pg_dump --version && pg_restore --version

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/backup ./
# The backup and envelope roots exist in the image owned by the runtime user,
# so fresh named volumes inherit writable mounts; the envelope lives on its own
# volume so a backup destination and the key that opens it are never the same
# place.
RUN mkdir -p /var/lib/porkbot/backups /var/lib/porkbot/backup-envelope && chown -R node:node /var/lib/porkbot
USER node
CMD ["node", "dist/cli.js", "run", "--if-due"]

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS supervisor

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/supervisor ./
# The snapshot directory the Docker computer provider writes into. It exists in
# the image so the named volume mounted here inherits the node user's ownership
# on first use; without it the daemon would create a root-owned volume and the
# provider could not write a snapshot.
RUN mkdir -p /var/lib/porkbot/computer-snapshots && chown -R node:node /var/lib/porkbot
USER node
EXPOSE 3003
CMD ["node", "dist/main.js"]

# syntax=docker/dockerfile:1

# The whole workspace is installed and built once, then each app is deployed
# with `pnpm deploy --prod` into its own runtime image. Compose builds the target
# a service names (compose.yaml), so `pnpm stack:up` pays for one install and one
# build, and every service image carries the app and its workspace dependencies
# rather than the toolchain.
#
# The base image carries the exact Node version from .nvmrc — pnpm's devEngines
# check refuses anything else — and is pinned by digest, so the stack builds
# from the image dependencies.json registers.

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

# The backup process is the one image built on the pinned Postgres image
# rather than the Node one, because `pg_dump` and `pg_restore` are the server's
# own major and a client older than its server refuses to dump it. Copying the
# Node binary from the same digest the other stages use keeps the app runtime
# identical; both images are Debian bookworm, so the binary's libraries are the
# ones already present. Nothing else from the Node image is needed — the app is
# deployed by `pnpm deploy` like every other service.
FROM postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280 AS backup

COPY --from=build /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production
ENV PATH="/usr/lib/postgresql/18/bin:${PATH}"
WORKDIR /app
COPY --from=build /deploy/backup ./
# The backup and envelope roots exist in the image owned by the runtime user,
# so fresh named volumes inherit writable mounts; the envelope lives on its own
# volume so a backup destination and the key that opens it are never the same
# place.
RUN mkdir -p /var/lib/porkbot/backups /var/lib/porkbot/backup-envelope && chown -R postgres:postgres /var/lib/porkbot
USER postgres
EXPOSE 3004
CMD ["node", "dist/main.js"]

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

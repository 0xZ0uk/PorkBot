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
RUN pnpm deploy --filter @porkbot/web --prod --legacy /deploy/web
RUN pnpm deploy --filter @porkbot/supervisor --prod --legacy /deploy/supervisor

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

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS web

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy/web ./
USER node
EXPOSE 3000
CMD ["node", "dist/host/main.js"]

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

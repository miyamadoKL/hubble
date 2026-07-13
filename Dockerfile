# syntax=docker/dockerfile:1
#
# Hubble SQL Workbench — single-process production image.
#
# The server runs the TypeScript sources directly via `tsx` (no transpiled
# artifact), so the runtime image ships the `server` and `contracts` sources
# plus the web build output. With `STATIC_DIR` set, the server also serves the
# SPA, so one container is enough. See docs/deployment.md and docs/operations.md.
#
# Build:   docker build -t hubble:0.1.0 .
# Run:     docker run --rm -p 8080:8080 -v hubble-data:/data \
#            -e TRINO_BASE_URL=http://trino:8080 hubble:0.1.0

# ---------------------------------------------------------------------------
# base: pinned Node 24 + pnpm via corepack (honours package.json packageManager)
# ---------------------------------------------------------------------------
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# corepack ships with Node 24; `enable` makes the `pnpm` shim resolve the
# version pinned in package.json's `packageManager` field (pnpm@11.6.0).
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: install the full workspace once (cached on lockfile changes)
# ---------------------------------------------------------------------------
FROM base AS deps
# better-sqlite3 builds a native addon; a prebuilt binary is fetched for
# linux/glibc (node:24-slim is Debian/glibc), but keep build tools available as
# a fallback in case the prebuilt is unavailable for the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so `pnpm install` is cached unless they change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
COPY e2e/package.json e2e/package.json

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder: bring in sources and build the web app (→ packages/web/dist)
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY . .
# `pnpm --filter web build` runs `tsc --noEmit && vite build`. The web package
# depends on @hubble/contracts, which is consumed directly as TS source
# (its package "main" points at src/index.ts), so no separate contracts build
# step is required to produce the web bundle.
RUN pnpm --filter web build

# ---------------------------------------------------------------------------
# prod-deps: production-only dependency tree for the server (+ contracts)
# ---------------------------------------------------------------------------
FROM deps AS prod-deps
# Prune to production deps for the server and its workspace dependencies.
# `@hubble/server...` (trailing `...`) includes @hubble/contracts.
# Docker build has no TTY; CI=true lets pnpm replace node_modules without prompting.
ENV CI=true
RUN pnpm install --prod --frozen-lockfile --filter "@hubble/server..."

# ---------------------------------------------------------------------------
# duckdb-httpfs: linux/amd64 用の DuckDB extension を production image に含める
# ---------------------------------------------------------------------------
FROM deps AS duckdb-httpfs
# aws と httpfs は image build 時に取得する。runtime gate は autoload と
# autoinstall を無効にするため、最初の request は network access を発生させない。
RUN pnpm --filter @hubble/server exec node --input-type=module -e "import { DuckDBInstance } from '@duckdb/node-api'; const instance = await DuckDBInstance.create(':memory:'); const connection = await instance.connect(); await connection.run('INSTALL aws'); await connection.run('INSTALL httpfs'); connection.disconnectSync(); instance.closeSync();"
RUN mkdir -p /home/node/.duckdb && cp -a /root/.duckdb/extensions /home/node/.duckdb/extensions && chown -R node:node /home/node/.duckdb

# ---------------------------------------------------------------------------
# runtime: minimal image running the server with tsx
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV HOME=/home/node
# Single-process defaults: serve the built SPA and persist SQLite under /data.
ENV STATIC_DIR=/app/packages/web/dist
ENV DB_PATH=/data/hubble.db
ENV PORT=8080

# Workspace metadata (pnpm resolves the workspace graph at runtime for `start`).
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Production node_modules (root + per-package) from the pruned install.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=duckdb-httpfs --chown=node:node /home/node/.duckdb /home/node/.duckdb

# Server + contracts sources (executed directly via tsx) and their manifests.
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/package.json
COPY --chown=node:node packages/contracts/src ./packages/contracts/src
COPY --chown=node:node packages/contracts/tsconfig.json ./packages/contracts/tsconfig.json
COPY --chown=node:node packages/server/package.json ./packages/server/package.json
COPY --chown=node:node packages/server/src ./packages/server/src
COPY --chown=node:node packages/server/migrations ./packages/server/migrations
COPY --chown=node:node packages/server/tsconfig.json ./packages/server/tsconfig.json
COPY --chown=node:node tsconfig.base.json ./tsconfig.base.json

# Built SPA from the builder stage.
COPY --from=builder --chown=node:node /app/packages/web/dist ./packages/web/dist

# SQLite lives here; declare it a volume so data survives container restarts.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

# `pnpm --filter @hubble/server start` would be equivalent, but the corepack
# shim downloads pnpm on first use (runtime stage has no corepack cache), which
# breaks air-gapped startup. Invoke the workspace-installed tsx directly instead.
WORKDIR /app/packages/server
CMD ["node_modules/.bin/tsx", "src/index.ts"]

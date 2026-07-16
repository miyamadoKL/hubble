# syntax=docker/dockerfile:1
#
# Hubble SQL Workbench — single-process production image.
#
# The server runs the TypeScript sources directly via `tsx` (no transpiled
# artifact), so the runtime image ships the `server` and `contracts` sources
# plus the web build output. With `STATIC_DIR` set, the server also serves the
# SPA, so one container is enough. See docs/deployment.md and docs/operations.md.
#
# ビルド:   docker build -t hubble:0.1.0 .
# 起動例:   docker run --rm -p 8080:8080 \
#            -e DATABASE_URL=postgres://hubble:hubble@postgres:5432/hubble \
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
# runtime: minimal image running the server with tsx
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV HOME=/home/node
# 単一プロセスの既定値。ビルド済みSPAを配信し、永続化にはPostgreSQLを使う。
ENV STATIC_DIR=/app/packages/web/dist
ENV PORT=8080

# Workspace metadata (pnpm resolves the workspace graph at runtime for `start`).
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Production node_modules (root + per-package) from the pruned install.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/server/node_modules ./packages/server/node_modules

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

USER node
EXPOSE 8080

# `pnpm --filter @hubble/server start` would be equivalent, but the corepack
# shim downloads pnpm on first use (runtime stage has no corepack cache), which
# breaks air-gapped startup. Invoke the workspace-installed tsx directly instead.
WORKDIR /app/packages/server
CMD ["node_modules/.bin/tsx", "src/index.ts"]

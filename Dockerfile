# syntax=docker/dockerfile:1.7
#
# CSQ API image. Three stages:
#   build      full dependency tree, tsc, then scripts/copy-assets.mjs copies
#              every non-TypeScript file under src/ (the surveys YAML and the
#              airports CSV) to dist/ so `new URL('./data/x', import.meta.url)`
#              resolves at runtime exactly as it does from src/.
#   prod-deps  production node_modules only.
#   runtime    node:22-alpine, non-root, dist/ + node_modules + package.json
#              (src/core/version.ts reads ../../package.json for name/version).
#
# Inside the image there is no tsx and no src/, so the seed scripts run from
# dist/ (same code, compiled):
#   node dist/seed/seed.js --super-admin email=you@acfi.in name="Your Name"
#   node dist/seed/demo.js [--reset]
# docker-compose.yml / deploy/README.md show the compose form of both.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ scripts/
COPY src/ src/
RUN npm run build

FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4000
COPY --chown=node:node package.json ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4000
# /api/v1/health answers 503 when the Mongo ping fails, which busybox wget
# treats as a failure, so the container goes unhealthy with its database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" > /dev/null || exit 1
# server.ts handles SIGTERM itself (scheduler stop, server close, db
# disconnect); compose adds `init: true` so PID 1 also reaps.
CMD ["node", "dist/server.js"]

# Multi-stage so the runtime image carries no toolchain, no dev dependencies and
# no source. Differs deliberately from the axiomsafe backend image, which ships
# the full node:20 base (~1GB), installs with `npm install` rather than a locked
# install, and runs as root.
FROM node:20.18-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json      packages/core/
COPY apps/api/package.json           apps/api/
# --frozen-lockfile fails the build if the lockfile and manifests disagree,
# rather than silently resolving something different from what was tested
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/api  apps/api
COPY tsconfig.base.json ./
RUN pnpm -r build
RUN pnpm deploy --filter @csq/api --prod /out

FROM node:20.18-alpine AS runtime
ENV NODE_ENV=production TZ=Asia/Kolkata
RUN apk add --no-cache tini tzdata \
    && addgroup -g 10001 -S csq && adduser -u 10001 -S csq -G csq
WORKDIR /app
COPY --from=build --chown=csq:csq /out ./
USER csq
EXPOSE 4000

# Config arrives as environment at runtime. Nothing secret is ever COPYed into
# a layer: an image layer is permanent and readable by anyone who can pull it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

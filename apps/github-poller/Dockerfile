# The poller's Railway image. Built from the repo root, because a pnpm workspace member cannot be
# built in isolation -- it depends on four sibling packages by `workspace:*`.
#
#   docker build -f apps/github-poller/Dockerfile -t github-poller .
#
# A multi-stage build so the shipped image carries the bundle and production dependencies only,
# not the toolchain that produced them.

FROM node:24-slim AS build
WORKDIR /repo

RUN corepack enable

# The manifests first, so a dependency install is cached across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json biome.json ./
COPY packages/event-model/package.json packages/event-model/
COPY packages/integration-core/package.json packages/integration-core/
COPY packages/event-sink/package.json packages/event-sink/
COPY packages/github/package.json packages/github/
COPY apps/github-poller/package.json apps/github-poller/

RUN pnpm install --frozen-lockfile --filter @personal-events/github-poller...

COPY packages/ packages/
COPY apps/github-poller/ apps/github-poller/

RUN pnpm --filter @personal-events/github-poller... build

FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# The bundle is self-contained apart from Node itself; tsup resolves the workspace packages into it.
COPY --from=build /repo/apps/github-poller/dist ./dist

# Not root. The poller reads two GitHub tokens and a set of AWS credentials from the environment.
USER node

CMD ["node", "--enable-source-maps", "dist/index.js"]

# The relay of the GitHub webhooks. Build from the root of the repository: pnpm
# needs the workspace files and the lockfile.
#
#   docker build -f packages/relay/Dockerfile -t boo-relay .

# Keep NODE_VERSION in the major of `.nvmrc`, which the workflows read.
ARG NODE_VERSION=26.12.1

# Keep the tag equal to `packageManager` in the root package.json.
FROM ghcr.io/pnpm/pnpm:11.17.0@sha256:e26f380828856f205feaaf42abd157df9ce41bc8e17b662eeaa3379a9638dee0 AS pnpm

FROM node:${NODE_VERSION}-slim AS build
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm
# The `prepare` script of the root installs the git hooks. An image has no git repository.
ENV HUSKY=0
WORKDIR /app
COPY --link package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --link packages/relay/package.json ./packages/relay/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @sakuga-software/boo-relay
COPY --link packages/relay ./packages/relay
RUN pnpm --filter @sakuga-software/boo-relay run build

# The relay has no runtime dependency: the image carries only Node and the build.
FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    PORT=3000 \
    RELAY_DATA_DIR=/data
# The image carries no pnpm, npm or corepack.
RUN apt-get update -qq && \
    apt-get upgrade -y && \
    rm -rf /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack && \
    mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build --link /app/packages/relay/package.json ./
COPY --from=build --link /app/packages/relay/dist ./dist
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((answer) => process.exit(answer.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

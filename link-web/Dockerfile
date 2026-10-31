# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f link-web/Dockerfile -t bigboss-link-web .

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY link-web/package.json link-web/
RUN npm ci --workspace link-web --workspace @bigboss/shared --include-workspace-root=false --include=dev
COPY packages/shared packages/shared
COPY link-web link-web
RUN npm run build -w @bigboss/shared && npm run build -w link-web \
  && npm prune --omit=dev --workspace link-web --workspace @bigboss/shared --include-workspace-root=false \
  && mkdir -p link-web/node_modules

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
# Workspace layout is preserved so @bigboss/shared resolves through node_modules.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/link-web/node_modules ./link-web/node_modules
COPY --from=build --chown=node:node /repo/link-web/package.json ./link-web/package.json
COPY --from=build --chown=node:node /repo/link-web/dist ./link-web/dist
USER node
WORKDIR /app/link-web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

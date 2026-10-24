# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f backend/Dockerfile -t bigboss-backend .

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY backend/package.json backend/
RUN npm ci --workspace backend --workspace @bigboss/shared --include-workspace-root=false
COPY packages/shared packages/shared
COPY backend backend
RUN npm run build -w @bigboss/shared && npm run build -w backend \
  && npm prune --omit=dev --workspace backend --workspace @bigboss/shared --include-workspace-root=false \
  && mkdir -p backend/node_modules

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
# Workspace layout is preserved so @bigboss/shared resolves through node_modules.
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /repo/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /repo/backend/node_modules ./backend/node_modules
COPY --from=build --chown=node:node /repo/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /repo/backend/dist ./backend/dist
USER node
WORKDIR /app/backend
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

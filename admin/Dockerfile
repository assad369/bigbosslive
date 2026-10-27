# syntax=docker/dockerfile:1.7
# Build from the repository root:
#   docker build -f admin/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t bigboss-admin .
# Vite inlines VITE_* at build time, so changing them needs a rebuild (Coolify: build variables).

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY admin/package.json admin/
RUN npm ci --workspace admin --workspace @bigboss/shared --include-workspace-root=false --include=dev
COPY packages/shared packages/shared
COPY admin admin
ARG VITE_API_URL
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ENV VITE_API_URL=$VITE_API_URL \
    VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID
RUN npm run build -w @bigboss/shared && npm run build -w admin

FROM nginx:1.27-alpine AS runtime
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/admin/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

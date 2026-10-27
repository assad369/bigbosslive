# syntax=docker/dockerfile:1.7
# Build from the repository root:
#   docker build -f games/Dockerfile --build-arg VITE_API_URL=https://api.example.com -t bigboss-games .
# Serves /golden-wheel/, /fortune-ferris/ and /teen-patti/ (opened by the app in a WebView).

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY games/package.json games/
RUN npm ci --workspace games --workspace @bigboss/shared --include-workspace-root=false --include=dev
COPY packages/shared packages/shared
COPY games games
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w @bigboss/shared && npm run build -w games

FROM nginx:1.27-alpine AS runtime
COPY games/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/games/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

# Deploying on a Hostinger VPS with Coolify

This guide runs the API, Redis, the admin dashboard and the mini-games on a single Hostinger VPS
managed by [Coolify](https://coolify.io) v4. MongoDB runs on **MongoDB Atlas** and media runs on
**LiveKit Cloud**. Everything else in [DEPLOYMENT.md](DEPLOYMENT.md) still applies; this page covers
only the Coolify-specific setup.

Replace `example.com` with your domain throughout.

## 1. What runs where

| Component | Where | Coolify resource | Public URL | Container port |
|---|---|---|---|---|
| API (Express, Socket.IO, BullMQ workers) | VPS | Application, Dockerfile `backend/Dockerfile` | `https://api.example.com` | 3000 |
| Redis 7 | VPS | Database, Redis | none (internal only) | 6379 |
| Admin dashboard | VPS | Application, Dockerfile `admin/Dockerfile` | `https://admin.example.com` | 80 |
| Mini-games | VPS | Application, Dockerfile `games/Dockerfile` | `https://games.example.com` | 80 |
| MongoDB (replica set) | MongoDB Atlas | none | none | n/a |
| LiveKit SFU | LiveKit Cloud | none | `wss://<project>.livekit.cloud` | n/a |
| Auth, FCM | Firebase | none | none | n/a |
| Uploads | Cloudflare R2 / S3 | none | `S3_PUBLIC_BASE_URL` | n/a |

Coolify's Traefik proxy terminates TLS (Let's Encrypt) and forwards WebSocket upgrades, so
Socket.IO works without extra configuration. All three images build from the **repository root**
(the root `.dockerignore` keeps the build context small).

## 2. Prepare the Hostinger VPS

1. **Plan:** at least 2 vCPU and 8 GB RAM (for example KVM 2). The API itself is light, but
   building the admin bundle on the server needs memory.
2. **OS:** in hPanel → VPS → *OS & Panel*, pick **Ubuntu 24.04 with Coolify** (Hostinger's
   template), or plain Ubuntu 24.04 and then, as root:
   ```bash
   curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
   ```
3. **Swap** (avoids out-of-memory kills during `npm ci` / `vite build`):
   ```bash
   fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   ```
4. **Firewall** (hPanel → VPS → *Security* → *Firewall*): allow inbound TCP `22`, `80`, `443`,
   `8000` (Coolify dashboard), `6001` and `6002` (Coolify realtime and terminal). Once the
   dashboard has its own domain (step 6), you can close `8000`.
5. **DNS:** create `A` records pointing at the VPS IP for `api`, `admin`, `games` and `coolify`.
   If you use Cloudflare, start with *DNS only* (grey cloud) until certificates are issued. See
   `TRUST_PROXY` below if you later turn the proxy on.
6. Open `http://<vps-ip>:8000`, create the admin account, then in *Settings* set the instance
   domain to `https://coolify.example.com`.

## 3. External services

### MongoDB Atlas

The API uses multi-document transactions, so it needs a replica set. Every Atlas cluster is one.

1. Create a cluster in the region closest to the VPS. Use **M10 or larger for production**,
   because continuous backup and point-in-time restore protect the `ledger`. A free or Flex tier
   is fine for staging.
2. *Database Access:* create a user with `readWrite` on `bigbosslive`.
3. *Network Access:* add the VPS public IP. Without it, the API hangs at boot and then fails with a
   server selection timeout.
4. Copy the SRV connection string and add the write options:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=bigboss`
   URL-encode special characters in the password.

### LiveKit Cloud

1. Create a project and an API key/secret (*Settings → Keys*).
2. *Settings → Webhooks:* add `https://api.example.com/v1/webhooks/livekit`, signed with the
   **same API key** the backend uses. Viewer counts and room presence depend on this webhook.

### Firebase

1. *Project settings → Service accounts → Generate new private key*, then base64 it on one line:
   ```bash
   base64 -i service-account.json | tr -d '\n'
   ```
   The result goes into `FIREBASE_SERVICE_ACCOUNT_BASE64`. Don't commit the JSON.
2. *Authentication → Settings → Authorised domains:* add `admin.example.com`.
3. For Play purchases, give the same service account *View financial data* and *Manage orders*
   in Play Console.

### Object storage (R2 / S3)

Create the bucket, a public CDN domain (`S3_PUBLIC_BASE_URL`), and a CORS rule that allows `PUT`
and `GET` (uploads go straight from the apps by presigned URL).

## 4. Coolify project and Git source

1. *Sources → + Add → GitHub App*, install it on the repository.
2. *Projects → + Add* → `bigbosslive` → environment `production`.
3. Every application below uses the same Git source, branch `main`, and **Base Directory `/`**.
   Auto-deploy on push is enabled by default for GitHub App sources.

## 5. Redis

1. In the project: *+ New → Databases → Redis* (7.x).
2. Keep the generated password. Leave **Make it publicly available** off.
3. *Custom Redis Configuration:*
   ```
   maxmemory-policy noeviction
   appendonly yes
   ```
   BullMQ needs `noeviction`, because evicted job keys are silently lost jobs.
4. Start it and copy the **Redis URL (internal)**, for example
   `redis://default:<password>@<resource-uuid>:6379/0`. It becomes `REDIS_URL`.
5. *Backups:* Coolify has no scheduled backups for Redis. It holds only rate-limit counters and
   job queues, so the AOF on the volume is enough.

## 6. API (backend)

*+ New → Application → Private Repository (with GitHub App)* → this repo.

**General**

| Setting | Value |
|---|---|
| Build Pack | `Dockerfile` |
| Base Directory | `/` |
| Dockerfile Location | `/backend/Dockerfile` |
| Ports Exposes | `3000` |
| Ports Mappings | *(leave empty: Traefik routes by domain, and a host port blocks rolling updates)* |
| Domains | `https://api.example.com` |
| Post-deployment Command | `node dist/cli/scripts/migrate.js` |

**Health check** (*Health Checks* tab): enabled, path `/healthz`, port `3000`. Coolify waits for
the new container to be healthy before it switches traffic (rolling update). Don't use `/readyz`
here: a brief Atlas or Redis blip would mark the container unhealthy and take the API out of the
proxy.

**Environment variables:** set every one to runtime only, with *Available at Buildtime*
**unchecked**. The image doesn't read them during the build, and a build-time
`NODE_ENV=production` is what Coolify warns about. The Dockerfiles install dev dependencies
regardless (`npm ci --include=dev`).

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `LOG_LEVEL` | `info` |
| `TRUST_PROXY` | `1` (Traefik). Use `2` if Cloudflare's orange-cloud proxy sits in front. |
| `PUBLIC_BASE_URL` | `https://api.example.com` |
| `CORS_ORIGINS` | `https://admin.example.com,https://games.example.com` |
| `MONGODB_URI` | Atlas SRV string from §3 |
| `MONGODB_DB` | `bigbosslive` |
| `REDIS_URL` | internal Redis URL from §5 |
| `FIREBASE_PROJECT_ID` | your Firebase project id |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | base64 JSON from §3 |
| `LIVEKIT_URL` | `wss://<project>.livekit.cloud` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | from LiveKit Cloud |
| `LIVEKIT_TOKEN_TTL_SECONDS` | `21600` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | storage credentials (`S3_REGION=auto` for R2) |
| `GOOGLE_PLAY_PACKAGE_NAME` | `com.bigbosslive.app` |
| `APPLE_BUNDLE_ID`, `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_BASE64`, `APPLE_ENVIRONMENT` | App Store Server API (`base64 -i AuthKey_XXX.p8 \| tr -d '\n'`) |
| `JOBS_ENABLED` | `true` |
| `AGENCY_RESET_TIMEZONE` | `Asia/Dhaka` |

The server validates its environment at boot and refuses to start in production without
`REDIS_URL`, `LIVEKIT_*` and `FIREBASE_PROJECT_ID`. Any problem shows up as one error in the
deployment logs, listing every bad variable.

Mark secrets (`*_SECRET`, `*_BASE64`, `MONGODB_URI`, `REDIS_URL`, `S3_SECRET_ACCESS_KEY`) as
locked in Coolify so they aren't shown in the UI.

## 7. Admin dashboard and games

Create two more applications from the same repository:

| Setting | Admin | Games |
|---|---|---|
| Build Pack | `Dockerfile` | `Dockerfile` |
| Base Directory | `/` | `/` |
| Dockerfile Location | `/admin/Dockerfile` | `/games/Dockerfile` |
| Ports Exposes | `80` | `80` |
| Domains | `https://admin.example.com` | `https://games.example.com` |

Vite bakes `VITE_*` values into the bundle **at build time**. Add them as environment variables
with **Build Variable** (*Available at Buildtime*) checked. After changing one, **redeploy**:
a restart isn't enough.

| Variable | Admin | Games |
|---|---|---|
| `VITE_API_URL` | `https://api.example.com` | `https://api.example.com` |
| `VITE_FIREBASE_API_KEY` | Firebase web config | n/a |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase web config | n/a |
| `VITE_FIREBASE_PROJECT_ID` | Firebase web config | n/a |
| `VITE_FIREBASE_APP_ID` | Firebase web config | n/a |

Both images serve static files with nginx and the same headers as the `vercel.json` files: SPA
fallback for admin, and multi-page `/golden-wheel/`, `/fortune-ferris/` and `/teen-patti/` for
games. Hashed `/assets/*` files are cached for a year, and `index.html` is never cached, so a
redeploy takes effect right away.

## 8. First deploy

1. Deploy **Redis**, then the **API**. Watch the deployment log until the health check passes.
   The post-deployment command creates indexes and applies migrations.
2. In the API resource, open **Terminal** (working directory `/app/backend`) and run:
   ```bash
   node dist/cli/scripts/seed.js                                   # catalog data, idempotent
   node dist/cli/scripts/set-admin.js owner@example.com superadmin # first dashboard admin
   ```
   The owner account must already exist in Firebase Auth (sign in once from the app or console).
   Never run `demo-data.js` in production.
3. Deploy **admin** and **games**.
4. Sign in at `https://admin.example.com`, then:
   - set *Settings* (economy, features, app links)
   - in *Games*, enable each game and set its URL: `https://games.example.com/golden-wheel/`,
     `https://games.example.com/fortune-ferris/`, `https://games.example.com/teen-patti/`
   - create recharge packages whose ids match your store product ids
5. Build the mobile apps against the API:
   `flutter build appbundle --dart-define=API_URL=https://api.example.com` (see
   [app/README.md](../app/README.md)).

## 9. Verify

```bash
curl -s https://api.example.com/healthz        # {"status":"ok"}
curl -s https://api.example.com/readyz         # {"mongo":true,"redis":true}
curl -si https://api.example.com/metrics | head -1   # 404: blocked for proxied traffic
curl -si "https://api.example.com/socket.io/?EIO=4&transport=polling" | head -1   # 200
curl -sI https://admin.example.com/some/deep/link | grep -i x-frame-options   # DENY (SPA fallback)
curl -sI https://games.example.com/golden-wheel/ | head -1                    # 200
```

Then go live from the app and confirm the room appears in the live list with a viewer count.
That exercises LiveKit tokens and the webhook end to end.

## 10. Operations

- **Logs:** each resource's *Logs* tab shows JSON (pino) logs with a `requestId`.
- **Deploys and rollback:** every push to `main` redeploys. *Deployments* lists earlier builds,
  and you can redeploy any of them to roll back. Migrations only move forward, so write them to be
  backward compatible.
- **Scaling:** one VPS runs one API container. BullMQ repeatable jobs and the Socket.IO Redis
  adapter are already multi-replica safe, so you can add servers to Coolify later and deploy more
  replicas with no code change. Keep `JOBS_ENABLED=true` unless you split out dedicated workers
  (see [DEPLOYMENT.md](DEPLOYMENT.md#scaling-and-workers)).
- **Metrics:** `/metrics` answers only requests that don't pass through the proxy. Scrape it from
  a container on the same Docker network (`http://<api-container>:3000/metrics`).
- **Backups:** Atlas continuous backups and point-in-time restore are the financial record. Also
  turn on Coolify's own backup to S3 (*Settings → Backup*) for the Coolify instance.
- **Updates:** keep Ubuntu (`unattended-upgrades`) and Coolify (*Settings → Update*) current. The
  base images are pinned to major versions (`node:22-alpine`, `nginx:1.27-alpine`), so a redeploy
  picks up their patches.

## 11. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Build fails with `sh: tsc: not found` | The image predates the fix that declares `typescript` in each workspace. Pull the latest `main` and redeploy. Also uncheck *Available at Buildtime* on the backend variables. |
| `Docker Compose file must contain a "services" section` | The Build Pack is set to *Docker Compose*. Switch it to **Dockerfile** (or recreate the app and pick Dockerfile). |
| Deploy fails with `Invalid environment configuration` or `Missing required production configuration` | A required variable is missing or malformed. The log lists each one. |
| Boot hangs ~30 s, then `MongoServerSelectionError` | The VPS IP isn't in Atlas *Network Access*, or the URI or password is wrong (URL-encode it). |
| `/readyz` shows `"redis": false` | `REDIS_URL` isn't the **internal** URL, or the password is wrong. |
| 502 / *no available server* | *Ports Exposes* doesn't match the container (3000 for the API, 80 for admin and games), or the health check is failing. |
| Admin calls `localhost:3000` | `VITE_API_URL` wasn't a build variable, or you restarted instead of redeploying. |
| Browser CORS error from admin or games | The origin, with exact scheme and no trailing slash, is missing from `CORS_ORIGINS`. |
| Firebase `auth/unauthorized-domain` on admin sign-in | Add `admin.example.com` to Firebase authorised domains. |
| Rate limits hit everyone at once or client IPs look wrong | `TRUST_PROXY` doesn't match the number of proxies (1 for Traefik, 2 with the Cloudflare proxy). |
| Viewer counts stay at 0 | The LiveKit webhook URL is wrong or signed with a different API key. |
| Build killed (exit 137) | The VPS ran out of memory. Add swap (§2) or a larger plan. |

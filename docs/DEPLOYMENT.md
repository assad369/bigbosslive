# Deployment

## Production checklist

| Item | Requirement |
|---|---|
| MongoDB | **Replica set** (Atlas M10+ or self-hosted, 3 nodes). Transactions are mandatory. |
| Redis | Managed Redis 7 (rate limits, Socket.IO adapter, BullMQ). `noeviction` policy. |
| LiveKit | LiveKit Cloud or a self-hosted cluster with TURN. Webhook → `https://api…/v1/webhooks/livekit`. |
| Firebase | Auth providers (Google, Apple, Phone), service account for the API, FCM, Crashlytics. |
| Storage | Cloudflare R2 / S3 bucket with a public CDN domain (`S3_PUBLIC_BASE_URL`). CORS must allow `PUT` from the apps. |
| Stores | Google Play service account access (financial data + orders). App Store Connect API key for the In-App Purchase API. |
| TLS | Terminate at the load balancer or nginx (`infra/nginx.conf.example`). Forward WebSocket upgrades. |

## API server

Build and run the container (multi-stage, non-root, `tini`, health check):

```bash
docker build -f backend/Dockerfile -t registry.example.com/bigboss-backend:$(git rev-parse --short HEAD) .
```

Required environment variables (see `backend/.env.example`):

- `NODE_ENV=production`, `PORT`, `TRUST_PROXY` (number of proxy hops), `CORS_ORIGINS`
  (admin and games origins), `PUBLIC_BASE_URL`
- `MONGODB_URI`, `MONGODB_DB`, `REDIS_URL`
- `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_BASE64` (base64 of the JSON key)
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `S3_*` for uploads. `GOOGLE_PLAY_PACKAGE_NAME` and `APPLE_*` for purchases.

The server refuses to boot in production without Redis, LiveKit and Firebase configuration.

**Probes:** liveness `GET /healthz`, readiness `GET /readyz` (checks Mongo and Redis).
**Metrics:** `GET /metrics` (Prometheus). It is blocked for proxied requests in production, so
scrape it on the pod IP. **Shutdown:** SIGTERM drains sockets, the HTTP server, workers and DB
connections (25 s budget).

### First deploy

```bash
npm run migrate -w backend            # ensures indexes, applies versioned migrations
npm run seed -w backend               # catalog data (idempotent)
npm run set-admin -w backend -- owner@yourcompany.com superadmin
```

Then sign in to the admin dashboard and set Settings (economy, features, app links). Enable
games and set their hosted URLs. Create recharge packages that match your store product ids.

### Scaling and workers

- Run 2+ API replicas. They are stateless and need no sticky sessions (websocket transport).
- `JOBS_ENABLED=true` on every replica is safe: BullMQ repeatable jobs fire once per interval
  across the cluster. To isolate background load, run dedicated worker replicas with
  `JOBS_ENABLED=true` and API replicas with `JOBS_ENABLED=false`.
- Mongo pool: `maxPoolSize=50` per replica. Size the cluster to replicas × 50.

## Admin dashboard

Static SPA (Vite). Build with `VITE_API_URL` and the `VITE_FIREBASE_*` web config, then deploy
`admin/dist` to Vercel, Netlify, Cloudflare Pages or S3 + CDN. `admin/vercel.json` sets SPA
rewrites and security headers. Add the dashboard origin to the API's `CORS_ORIGINS` and to
Firebase Auth's authorised domains.

## Games

`npm run build -w games` produces `games/dist` with `golden-wheel/`, `fortune-ferris/` and
`teen-patti/`. Host it on a CDN and set each game's URL in **Admin → Games**. The app opens it in
a WebView and passes the token in the URL fragment.

## Mobile apps

See [`app/README.md`](../app/README.md) for Firebase files, signing and store setup. Pass
`--dart-define=API_URL=https://api.yourdomain` for release builds.

## Operations

- **Logs:** JSON (pino) with `requestId`. Authorization headers are redacted.
- **Audit:** every admin write lands in `audit_logs` (Admin → Audit log).
- **Backups:** enable continuous backups and point-in-time restore on MongoDB, since the
  `ledger` is the financial record.
- **Level ladder or weight changes:** after saving, run *Re-level users* from Admin → Levels.
- **Monthly agency reset:** automatic, in `AGENCY_RESET_TIMEZONE`. Admin → Agencies can trigger
  it manually; it is idempotent.
- **Stuck game round:** Admin → Games → Rounds → *Void & refund*.

# Architecture

```
            ┌──────────────┐   REST /v1 + Socket.IO    ┌─────────────────────────────┐
 Flutter ──▶│  API (N×)    │──────────────────────────▶│ MongoDB replica set         │
  app       │ Express 5    │   transactions, indexes   │ (single source of truth)    │
            │ Socket.IO    │◀──── Redis ──────────────▶│ Redis: rate limits, socket  │
 Admin  ──▶ │ BullMQ worker│      adapter + queues     │ adapter, BullMQ             │
 (React)    └──────┬───────┘                           └─────────────────────────────┘
                   │ server SDK: tokens, sendData, forward, webhooks
 Games  ──▶  REST  ▼
 (WebView)  ┌──────────────┐  WebRTC media + data channel
            │   LiveKit    │◀────────────────────────────── app (publish/subscribe)
            └──────────────┘
 Firebase: Auth (ID tokens, custom claims for admin roles) · FCM push · Crashlytics
 R2/S3: media uploads via presigned PUT · Google Play / App Store: IAP verification
```

## Responsibilities

| Concern | Where | Notes |
|---|---|---|
| Identity | Firebase Auth | The API verifies ID tokens (`checkRevoked`). The profile is created by `POST /v1/auth/session`. |
| Admin roles | Firebase custom claim `adminRole` | Mirrored to `users.adminRole` for listing only. The permission matrix is `backend/src/middleware/rbac.ts`. |
| Data | MongoDB | Every collection and index is declared in `backend/src/db`. Money paths use multi-document transactions. |
| Media | LiveKit | The server mints tokens with metadata and receives webhooks for presence and room end. |
| In-room events | LiveKit data channel | `bb.*` topics (gift, chat, seats, pk, entry, kick, room ended), sent by the server only. |
| Personal events | Socket.IO `/` | `user:<uid>` rooms: chat, notifications, wallet updates, live directory. |
| Game rounds | Socket.IO `/games` | `game:<key>` rooms: round, totals, settled. |
| Background work | BullMQ | Push fan-out, announcements, plus ticks: games (1s), PK (2s), stale lives (30s), cosmetics/agency (hourly). |
| Uploads | R2/S3 | `POST /v1/uploads/presign` → client PUT. Keys are server-generated. |
| Purchases | Play / App Store | The server verifies, credits once per store transaction id, and consumes on Google. |

## Request lifecycle

`requestId` → `pino-http` → metrics → helmet → CORS → compression → (webhooks with raw body) →
`express.json` → global rate limit → router (`requireAuth`, zod parse, permission) → service →
central error handler (`{ error: { code, message, details, requestId } }`).

## Money model

- **Diamonds**: bought (IAP, agent, admin) and spent (gifts, VIP, cosmetics, games).
- **Beans**: earned from gifts received (after platform and agency commission). They can be
  withdrawn.
- **Agent stock**: an agent's resale inventory, moved to users' diamonds by agent recharge.

Each movement is a conditional `$inc` plus a `ledger` row in one transaction, so the ledger
always reconciles to the balance. The game test suite checks this directly. Idempotency keys
make every client-initiated money action safe to retry.

## Level model

`points = totalRecharged + ⌊totalReceived × receivedLevelWeight⌋`. Levels come from the admin
ladder in `level_configs`. The level is recalculated inside the transaction that moved the
counter, and minted into the LiveKit token so every in-room surface shows the same value.

## Live room model

A host has at most one `live` room. Each session gets a unique LiveKit room name
(`bb_<uid>_<ms>`). Seats: index 0 is the host. Video rooms have 3 guest seats and audio rooms
have `live.audioSeatCount`. Taking a seat is an atomic `$elemMatch` update, and publish
permission is granted through the LiveKit API. Rooms end via the host, an admin, the webhook,
or the stale sweeper, and exactly one ender runs the side effects (live time, agency time, PK
forfeit, cleanup).

## PK model

Documents carry every deadline (`inviteExpiresAt`, `endsAt`). The sweeper enforces them, with
no timers in memory. `pkLive` + a partial unique index enforce one battle per host. Gift
scoring happens after the gift commits, from the debited amount only. Media crosses rooms by SFU
forwarding.

## Scaling

The API is stateless: any number of replicas behind a load balancer (sticky sessions are not
required with the `websocket` transport). Socket.IO uses the Redis adapter, and BullMQ ticks
fire once per interval cluster-wide. MongoDB and Redis are managed services. LiveKit scales
separately (LiveKit Cloud or a self-hosted cluster). For PK forwarding, both rooms must be on
the same LiveKit deployment.

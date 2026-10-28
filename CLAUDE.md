# CLAUDE.md

Guidance for anyone (human or agent) changing this repository. Read the relevant section before
touching money, live rooms, PK or games: those rules exist because the naive version is wrong.

## Layout

npm workspaces: `packages/shared`, `backend`, `admin`, `games`. The Flutter app in `app/` is
separate (pub). `packages/shared` must be built (`npm run build:shared`) before the others
typecheck. It holds the API types, `SOCKET` and `LIVEKIT_TOPICS` names, and the colour tokens.

## Commands

```bash
npm run lint | format:check | typecheck
npm test -w backend                      # MONGOMS_SYSTEM_BINARY=/path/to/mongod to skip the download
npm run dev:backend | dev:admin | dev:games
cd app && flutter analyze && flutter test && dart format lib test
```

## Backend conventions (`backend/src`)

- **Layering:** `routes/*` (HTTP, validation, auth) → `modules/<domain>/*.service.ts` (business
  rules) → MongoDB via `ctx.col.<collection>`. Services reach each other through `ctx.services`,
  resolved at call time, so there are no import cycles.
- **Validation:** every body/query/param goes through zod (`parseBody/parseQuery/parseParams` in
  `lib/http.ts`). Express 5's `req.query` is read-only, so parse it and never assign to it.
- **Errors:** throw `AppError` helpers from `lib/errors.ts`. Anything else becomes a generic 500.
- **Auth:** `requireAuth` (Firebase ID token → user doc → ban and device-ban checks). Admin access
  comes from the **token's** `adminRole` custom claim, never the Mongo mirror. Permissions live
  in `middleware/rbac.ts` (`PERMISSIONS`). Every admin write calls `audit(...)`.
- **Routers mounted at `/v1`** must scope `requireAuth` to their own prefixes
  (`r.use(['/gifts', …], requireAuth(ctx))`), or unknown routes turn into 401s instead of 404s.
- **Infra is behind interfaces** (`infra/*`): Firebase auth, FCM, LiveKit, S3, IAP. Tests swap in
  fakes (`test/helpers/harness.ts`). Never call an SDK directly from a service.
- **Storage settings:** R2 credentials are editable at `/admin/storage` (`config.manage` plus the
  `X-Admin-Passcode` header, matched against `STORAGE_SETTINGS_PASSCODE`, with failed guesses
  rate limited). They live in `app_config._id: 'storage'`, outside `CONFIG_SCHEMAS`, and override
  env `S3_*`. The secret is never returned or written to the audit log.
- **Time:** use `ctx.clock.now()`, never `new Date()`, in anything a test may need to control.
- **Pagination:** cursor lists sort `{ field: -1, _id: -1 }` and filter with `afterCursor()`.
  The `_id` tiebreak is required, because rows sharing a timestamp would otherwise be skipped.
- **Short IDs:** new accounts are numbered from `FIRST_SHORT_ID` (200) on the
  `user_short_id_v2` counter. Older accounts keep their 8-digit ids. Anything that accepts a
  short id uses `SHORT_ID_PATTERN` (3–12 digits) and resolves it with `users.resolve()`, which
  also accepts a uid.

## Money and invariants (read before changing)

- **Every balance change goes through `WalletService.debit/credit`** inside a transaction
  (`ctx.db.withTransaction`). Each writes a conditional `$inc` (it can never go negative) plus a
  `ledger` row. Nothing else may `$inc` a `wallet.*` field.
- **Idempotency:** gifts (`gift_transactions.idempotencyKey`), recharges, withdrawals, game bets,
  and VIP/cosmetic purchases (`lib/idempotency.ts` `once()`) are keyed by a client
  `Idempotency-Key`, scoped to the user. A retry returns the original result. Unique indexes are
  the guard, not read-then-write.
- **Level rule:** points = `stats.totalRecharged` + ⌊`stats.totalReceived` × `receivedLevelWeight`⌋.
  Only recharges (agent/admin/IAP) and gifts *received* move level. Gifts sent, game bets,
  purchases, agency commission and admin corrections (`wallet.adjust`) must **not**. Recalculate
  inside the same transaction that moved the counter. Thresholds live in `level_configs`.
- **Gift split:** receiver beans = cost − platform fee − agency fee, where the agency rate is
  capped by `economy.maxAgencyRate`. The agency owner's commission is credited in the same
  transaction. PK scoring and broadcasts run *after* commit and must not fail the gift.
- **Withdrawals** move beans out at request time (a hold). Rejection releases them. At most one
  pending request per user (partial unique index).

## Host agencies

- The owner is `agencies.ownerId` and never a member row. Members are `role: 'host' | 'admin'`.
  `AgenciesService.actor()` gates every `/agencies/mine/*` call. Owner-only actions are
  settings, roles, lock and targets. Agency admins handle applications, invitations and plain
  hosts.
- Hosts join only with consent: an application they send, or an invitation they accept.
  `addMemberIn` cancels the user's other pending applications and invitations in the same
  transaction. An agency owner can't be a host anywhere.
- A locked host can't `leave`. Only platform staff unlock (`/admin/agencies/:id/members/:uid/unlock`).
- Counters move inside the gift transaction (`recordEarnings`): the member's period and lifetime,
  `agency_daily_stats`, and the agency's own `period`/`lifetime`. A stale `period.key` reads as
  zero and is rolled forward, never back. Live time is split across zoned days.
- The home ranking (`/agencies/top`) sorts by this month's agency beans. It is cached for 15 s
  and dropped on create, update and monthly reset.
- Every agency action writes `agency_audit`.

## VIP ladder & cosmetics

- `vipTier` 1/2/3 = VIP/VVIP/King (`VIP_TIERS`). Higher tiers sort first in viewer lists and on
  the Popular tab (`liveRooms.hostVipTier`).
- The frame a user shows comes from `resolveFrame()`: an equipped store frame, else their active
  tier's frame (`equipped.vipFrame*`, copied from the package on purchase or grant and re-synced
  when the package changes). It is never read from `equipped` directly. Briefs, LiveKit
  metadata, PK hosts and room hosts all carry `frameUrl` + `frameFormat`.
- Entrance effect at `/join`: the equipped entry animation, else the tier's
  `entryAnimationUrl`. The app plays SVGA, Lottie and MP4 (muted) via `EffectView`, and draws
  every avatar with `BBAvatar.user()`.

## Live rooms

- One live room per host (partial unique index on `status: 'live'`). `start()` resumes an existing
  room instead of failing.
- LiveKit identity == uid. Tokens are minted server-side with metadata (level, VIP, role) and
  `canUpdateOwnMetadata: false`. Publish rights go only to the host and seated guests. A role
  change (seated, unseated, made room admin) re-mints the participant's grant and metadata via
  `livekit.updateParticipant` in the same call path.
- Video stage size is `live.videoSeatCount` (host included, max `MAX_VIDEO_SEATS` = 13). Seat
  mutes (`muted`, `videoMuted`) are enforced on the SFU with `livekit.muteTracks`; unmuting is
  left to the guest's client.
- Room admins = `moderatorIds`, appointed by the host only. They manage seats and requests and
  can remove people, but can't act on the host or other admins, lock the room or appoint admins.
  Kicking an admin revokes the role.
- Room lock (`locked`, `passwordHash`) is host-only and enforced at `/join`: staff, room admins
  and seated guests pass; others need the password (scrypt-hashed, guesses rate limited).
  Lock changes push `rooms:upserted` so home cards show the lock.
- Viewer counts come from `room_presence` rows maintained by LiveKit webhooks and recomputed on
  each event, so they are idempotent under redelivery.
- In-room chat goes through `POST /live/:id/chat` (moderated) and is fanned out on the data
  channel. Messages are kept in `live_messages` (7-day TTL) so replies, deletes and reports can
  reference them. Voice messages must be the sender's own `voice` upload
  (`storage.isOwnUpload`). Clients must ignore data packets that have a participant sender.
  Only server packets (`participant == null`) are trusted.
- Rooms with no heartbeat for `live.staleAfterSec` are ended by the `live.sweep` job.

## PK battles

- State machine: pending → active → ended, or pending → rejected/cancelled/expired. The only
  terminal writers are `terminatePending` and `end`, and both clear `pkLive` in the same update.
- Battles run in rounds (`pk.maxRounds`, best of N). Active rounds are `live` (gifts score only
  between `scoringOpensAt` and `endsAt`) or `paused` until a host calls `next-round`. Rounds won
  decide the winner, total score breaks ties. Round transitions are conditional on `round`.
  The partial unique index on `participantUids` (pkLive: true) enforces one battle per host.
- Deadlines are timestamps enforced by `pk.sweep`, with no in-memory timers.
- Cross-room video is SFU forwarding (`livekit.forwardParticipant`). Clients never connect to the
  other room.

## Games

- Server-authoritative round engine (`modules/games/games.service.ts`), driven by the
  `games.tick` job. Transitions are conditional updates, and settlement is per bet, conditional
  on `status: 'placed'`.
- Commit–reveal RNG (`rng.ts`). Never expose `serverSeed` before settlement (`toRound` hides it).
- `updateConfig` rejects weighted configs with RTP > 100%.

## Realtime & jobs

- Socket.IO namespaces: `/` (personal events and the live directory) and `/games`. Sockets join
  `user:<uid>`. Emit through `ctx.realtime`, which uses the Redis adapter in production.
- One-off jobs (`jobs/queue.ts`) and repeatable ticks (`jobs/scheduler.ts`) run on BullMQ, so
  they are leader-free across replicas. Without Redis they run in-process (dev only).

## Admin dashboard (`admin/`)

- Data access goes through `lib/api.ts` (`get`/`send`) + TanStack Query. Server lists use
  `ServerTable`, and forms use `FormModal`.
- Gate UI with `useAuth().can(permission)`. The server enforces it regardless.
- Colours come from `src/theme.ts` (`brand.palette`) only.

## Flutter app (`app/`)

- Colours: `BBColors` only (`lib/core/theme/bb_colors.dart`). It mirrors
  `packages/shared/src/theme.ts`, so change both together.
- API calls go through repositories (`lib/data/repositories.dart`), never `ApiClient` from
  widgets. Money-moving calls pass `idempotent: true`, and screens keep one
  `ApiClient.newIdempotencyKey()` per user *intent* (passed as `idempotencyKey:`), reused
  when the user retries after an error and dropped on success. A timeout on a keyed
  request may have gone through; minting a new key per tap would charge twice.
- In-app purchases go through `IapService` (`lib/core/iap/`), which listens for the app's
  lifetime. Never `completePurchase` on iOS before the server credited the purchase
  (finishing a transaction is final); on Android acknowledging is safe and unconsumed
  purchases are re-verified on start.
- The router's redirect (`redirectFor`) shows the splash only while nothing has loaded.
  A provider reloading with a value is not "booting": treating it as such sent users
  through `/splash` on every token refresh and dropped the live room.
- Define providers at top level. A provider created inside `build()` is a new provider every
  frame.
- `flutter analyze` must be clean and `dart format` stable. Both are enforced in CI.

# CLAUDE.md

Guidance for anyone (human or agent) changing this repository. Read the relevant section before
touching money, live rooms, PK or games: those rules exist because the naive version is wrong.

## Layout

npm workspaces: `packages/shared`, `backend`, `admin`, `games`, `link-web`. The Flutter app in `app/` is
separate (pub). `packages/shared` must be built (`npm run build:shared`) before the others
typecheck. It holds the API types, `SOCKET` and `LIVEKIT_TOPICS` names, and the colour tokens.

## Commands

```bash
npm run lint | format:check | typecheck
npm test -w backend                      # MONGOMS_SYSTEM_BINARY=/path/to/mongod to skip the download
npm run dev:backend | dev:admin | dev:games | dev:link
npm test -w link-web                     # node:test via tsx
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
- **Admin passwords:** an admin changes their own in the dashboard (profile menu), where Firebase
  re-authenticates with the current password client-side. A superadmin sets another admin's
  password with `POST /admin/admins/:uid/password` (`auth.setPassword`, which revokes their
  sessions). It never targets yourself or a non-admin, and the audit row has no payload.
- **Routers mounted at `/v1`** must scope `requireAuth` to their own prefixes
  (`r.use(['/gifts', …], requireAuth(ctx))`), or unknown routes turn into 401s instead of 404s.
- **Infra is behind interfaces** (`infra/*`): Firebase auth, FCM, LiveKit, S3, IAP. Tests swap in
  fakes (`test/helpers/harness.ts`). Never call an SDK directly from a service.
- **Storage settings:** R2 credentials are editable at `/admin/storage` (`config.manage` plus the
  `X-Admin-Passcode` header, matched against `STORAGE_SETTINGS_PASSCODE`, with failed guesses
  rate limited). They live in `app_config._id: 'storage'`, outside `CONFIG_SCHEMAS`, and override
  env `S3_*`. The secret is never returned or written to the audit log.
- **Maintenance mode:** while `app.maintenance` is on, only uids on the admin's list
  (`app_config._id: 'maintenance_access'`, outside `CONFIG_SCHEMAS`, `MaintenanceService`)
  get through. `requireAuth` answers everyone else with 503 `maintenance`, and so do the
  socket handshake and `/auth/session`. The admin router opts out (`duringMaintenance`), and
  `/auth/session` lets admin-claim tokens through for the dashboard. Staff get no app pass.
  The app gates on `me.maintenanceAccess`, and `ApiClient.onMaintenance` reacts to a 503
  arriving mid-session.
- **Time:** use `ctx.clock.now()`, never `new Date()`, in anything a test may need to control.
- **Pagination:** cursor lists sort `{ field: -1, _id: -1 }` and filter with `afterCursor()`.
  The `_id` tiebreak is required, because rows sharing a timestamp would otherwise be skipped.
- **Short IDs:** new accounts are numbered from `FIRST_SHORT_ID` (200) on the
  `user_short_id_v2` counter. Older accounts keep their 8-digit ids. Anything that accepts a
  short id uses `SHORT_ID_PATTERN` (1–12 digits) and resolves it with `users.resolve()`, which
  also accepts a uid. Admins assign ids (`setShortId`) matching `ASSIGNABLE_SHORT_ID_PATTERN`:
  from 1 upward, no `0` and no leading zero, so `1` and `01` never both exist.

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
- **One currency:** diamonds (`wallet.diamonds`) are bought, spent, earned and withdrawn.
  There are no beans. `agent_stock` is only an agent's resale inventory.
- **Gift split:** receiver diamonds = cost − platform fee − agency fee, where the agency rate is
  capped by `economy.maxAgencyRate`. The agency owner's commission is credited in the same
  transaction. PK scoring and broadcasts run *after* commit and must not fail the gift.
- **Withdrawals** move diamonds out at request time (a hold). Rejection releases them. At most one
  pending request per user (partial unique index). Any diamond can be withdrawn, bought ones
  included, so `economy.diamondsPerUsd` must keep a withdrawn diamond worth less than a
  recharged one.
- **After commit:** side effects that must not run for a rolled-back write go through
  `onCommit(session, fn)` (`lib/after-commit.ts`). `WalletService` uses it to push seated
  users' new balances to their live room (`publishSeatBalances`).

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
- The home ranking (`/agencies/top`) sorts by this month's agency diamonds. It is cached for 15 s
  and dropped on create, update and monthly reset.
- Every agency action writes `agency_audit`.
- Members join **locked** (`addMemberIn`, audited as a `system` `host_locked`). Migration
  `2026-11-10-agency-members-locked` locked the members who joined before.
- Agency members (hosts and agency admins, anyone with `users.agencyId`) can't send gifts:
  `GiftsService.send` answers 403 `agency_member_gift_blocked` before anything is charged.
  The owner has no `agencyId` and still gifts. The app's gift panel shows the block, and the
  join flows say both rules first (`confirmAgencyJoin`).

## Tier packages (VIP / VVIP / Crown / King) & cosmetics

- **Tiers:** `vipTier` 1/2/3/4 = VIP/VVIP/Crown/King (`VIP_TIERS`; King moved from 3 to 4 in
  migration `2026-11-10-tier-packages`). Higher tiers sort first in viewer lists and on the
  Popular tab (`liveRooms.hostVipTier`).
- **Model:** a tier package (`tier_packages`, `TierPackagesService` in `modules/vip`) is badge
  artwork sold for `durationDays`.
  - A user may own many (`user_tier_packages`, one row per package; buying again extends it) and
    wears one at a time.
  - The worn one is `users.vip` = `{ tier, expiresAt, packageId, badge }`, and that sets their
    tier. Any owned, unexpired package may be worn, a lower tier included.
  - `TierPackagesService` is the only writer of `users.vip`. Each write (`writeSlot`) also
    re-ranks the host's live room and, after commit, re-mints their LiveKit metadata
    (`LiveService.refreshIdentity`).
- **Expiry and edits:**
  - `activeVipTier()` / `activeBadge()` ignore an expired slot, and the hourly `store.sweep`
    clears it and drops the room rank.
  - A package's `tier` never changes after creation.
  - Editing the artwork re-syncs `vip.badge` on everyone wearing it.
  - A package is deleted only while nobody holds it. Otherwise it is deactivated, and grants may
    still use it.
- **The badge:** three renditions in their own fields (`badge.imageUrl/svgaUrl/mp4Url`, plus
  `blendMode`). Each URL's extension must match its field (`checkBadge`); an extensionless URL
  keeps its slot. Briefs, LiveKit metadata, PK hosts and room hosts carry `badge`.
- **App rendering:** `TierBadgeView` (`core/widgets/tier_badge.dart`) plays MP4 > SVGA > image.
  - Every failure falls to the next rendition.
  - MP4s are muted, looping, `mixWithOthers`, played from `TierBadgeVideoCache`, and metered by
    `VideoBadgeBudget` (6 at once, 3 while a live room is connected).
  - `additive` is a luminance-to-alpha `ColorFiltered`.
  - `BBAvatar` draws the badge at the photo's bottom-right (`AvatarBadgeSlot`: `size × 0.36`,
    none below 28). Chat rows show it inline (`InlineTierBadge`) with `showBadge: false` on the
    avatar, so it never appears twice. Tier pills and tints come from `VipTier`
    (`core/vip_tier.dart`).
- **Purchase:** idempotent (`once()`, scope `tier_package`) and debited as `vip_purchase`, so it
  never moves level.
- **Admin:** grants (`POST /admin/users/:uid/tier-packages`) are keyed by `Idempotency-Key`,
  scoped to the admin, audited once, free, and worn at once.
- **No tier frame or tier entrance effect:** tiers carry neither. `resolveFrame()` is the
  equipped store frame only, never read from `equipped` directly. The entrance effect at
  `/join` is the equipped entry animation only. The app plays effects via `EffectView`.
- **The decoration library (`cosmetics`):**
  - It is unlimited and paged in the admin.
  - A decoration with `vipIncluded` is a tier perk: holders of `vipTierRequired`+ wear it free
    without an ownership row, and it can't be bought.
  - Equipping records `equipped.<slot>VipTier` (0 = owned, else the entitling tier) and
    `equipped.<slot>ExpiresAt` (the ownership's expiry, null when worn through a tier).
    Readers go through `slotWearable()` (`resolveFrame()`, `resolveRoomBackground()`,
    `entryEffectFor()`), which drops an item the moment its tier lapses **or its ownership
    expires**, before `store.sweep` clears the slot. Buying or granting more days re-syncs
    the slot's expiry.
- **Slots:** `frame`, `entry_animation` and `room_background` (`EQUIPPABLE_COSMETIC_TYPES`).
  An equipped background is snapshotted onto the host's room as `decorBackgroundUrl` at
  go-live and on every change; a background the host sets for one live (`backgroundUrl`)
  still wins (`effectiveBackground`). `chat_bubble` has no design yet: it is left out of the
  app's store and wardrobe (`STORE_COSMETIC_TYPES`) and the admin can't create new ones.
- **Equip** (`StoreService.equip`) reads ownership and writes the slot in one transaction.
  Every equip, unequip, grant, revoke, edit and sweep re-mints live identity
  (`LiveService.refreshIdentities`, only for users live or watching now).
- **`store.sweep`** queries the users' own slots (`*ExpiresAt`, `*VipTier`) in batches.
  It never scans `user_cosmetics`, whose expired rows are kept: re-reading the same oldest
  batch is how it used to stall.
- **App store:** `GET /store/items` carries the caller's `owned` / `ownedUntil` / `equipped`.
  Tiles show Equipped / Owned; an owned item opens Equip / Take off / Extend; a tier-locked
  item sends to `/vip` instead of the buy dialog. Equip and unequip share one busy key per
  slot (`equip:<type>`) across the store tabs and Mine.
- **Editing a decoration:**
  - It re-syncs its wearers (`syncEquipped`).
  - Its type never changes.
  - Frames can't be MP4 (`FRAME_FORMATS`), and the format must match the file's extension.
- **Decoration grants** (`/admin/users/:uid/cosmetics`) are keyed and audited like tier package
  grants. A granted frame or entrance effect is equipped at once. A decoration is deleted only
  while nobody holds or wears it.

## Live rooms

- One live room per host (partial unique index on `status: 'live'`). `start()` resumes an existing
  room instead of failing.
- LiveKit identity == uid. Tokens are minted server-side with metadata (level, tier, badge, role) and
  `canUpdateOwnMetadata: false`. Publish rights go only to the host and seated guests. A role
  change (seated, unseated, made room admin) re-mints the participant's grant and metadata via
  `livekit.updateParticipant` in the same call path.
- Video stage size is `live.videoSeatCount` (host included, max `MAX_VIDEO_SEATS` = 13). Seat
  mutes (`muted`, `videoMuted`) are enforced on the SFU with `livekit.muteTracks`; unmuting is
  left to the guest's client.
- Host-spot swap: `live_rooms.swappedUid` puts a seated guest in the host's (largest) stage
  spot and the host in theirs (`POST /live/:id/stage/swap`, null restores). Host, room admins
  and staff with `live.moderate` (staff audited as `live.stage_swap`). It rides in
  `bb.seats { kind: 'seats', swappedUid }` and room detail, and `vacateSeatOf` clears it when
  that guest leaves the seat. The app orders `stage`/`displaySeats` by it (`activeSwap`, only
  while the guest is present) and swaps on long-press; PK ignores it.
- The bottom-bar phone of the host, room admins and platform moderators / `live.moderate`
  staff (`canManageStage`) opens `ParticipantsSheet` on WAITING (VIEWS / WAITING / STAGE /
  ADMINS; WAITING only for them, as the server refuses the queue to others). Their own seat
  action (Join, Cancel request, Go on stage, Leave) is the sheet's pill. Seat-request pushes
  reach only the host and `moderatorIds`, so the open sheet polls the queue for a hidden
  moderator.
- Stage order is join order: `occupySeat` stamps `seats.$.seatedAt` (cleared on vacate) and
  the app sorts guests by it (`LiveRoomController.stage`, falling back to the index for
  rooms without it), because a newcomer gets the lowest free index. Guest tiles show their
  spot (`spotOf`, 1-based among present guests) and no level. The tile ✕
  (`canRemoveFromStage`) is for the host, room admins (not on another admin) and
  `live.moderate` staff. Staff seat actions (`POST /live/:id/seats/:index`) need
  `live.moderate` and are audited as `live.seat_manage`.
- `/join` returns the joiner's own `entry` (the `bb.entry` payload, which goes out before
  they connect), and the app adds the joiner's own "joined" line once on connect
  (`_announceMyJoin`). The server echo for the same uid is then ignored. The controller's
  `entries` stream replays that own entrance to subscribers for a few seconds, because
  `EntryEffectOverlay` / `EntryBanner` mount only once the room has rendered.
- No entrance twice: `/join` with `resume: true` (the app's `_recover()`), or by someone who
  already has a `room_presence` row, broadcasts no `bb.entry` and returns `entry: null`.
- Room admins = `moderatorIds`, appointed by the host, a platform moderator or `live.moderate`
  staff (`setModerator`; non-hosts audited as `live.moderator_set`). Only staff take the role
  from a protected account. They manage seats and requests and can remove people, but can't act
  on the host or other admins, lock the room or appoint admins. Kicking an admin revokes the
  role.
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
- Room gifts go only to people in the room: the host, seated guests, or viewers with a
  `room_presence` row (`LiveService.firstAbsent`, else 400 `receiver_not_in_room`). Each one
  is saved as a `live_messages` row (`type: 'gift'`, `_id` = the gift transaction id, so never
  twice) and rides inside the `bb.gift` packet as `message`, not as a `bb.chat` packet. Older
  apps would show it twice. The app falls back to a local line when `message` is missing.
- Rooms with no heartbeat for `live.staleAfterSec` are ended by the `live.sweep` job.
- Broadcasting History and the post-live summary are in `LiveSummaryService`
  (`modules/live/live-summary.service.ts`):
  - `GET /users/:uid/live-history/monthly?month=YYYY-MM&tz=±HH:mm` groups ended lives by
    local start day.
  - `GET /live/:id/summary` is for the host, or staff with `live.read`, and answers 409
    while the room is live. It aggregates `gift_transactions` and `follows`. The first read
    after `endedAt + SUMMARY_SETTLE_MS` freezes it on `live_rooms.summary`; earlier reads
    are `final: false`.
  - Room counters `totalJoins`, `uniqueViewers` (deduped by `live_viewers`, 90-day TTL),
    `chatMessages` and `reactions` are absent on older rooms and read as null.
  - The app's `/history` is `BroadcastHistoryScreen`. Ending a live opens
    `/live-summary/:id`.
- Mic, camera and flip are in the bottom bar (`LiveBottomBar`) for the host and seated guests;
  on a narrow phone the chat field becomes a button and the heart goes. The rail keeps the
  rest. Speaking shows as `SpeakingBars` on tiles and `SpeakingGlow` on camera-off avatars
  (`speaking_indicator.dart`), driven by `c.speakers`; they animate only while active.
- Gift and entrance effects keep the clip's own sound (`EffectView(sound: true)`), mixed with
  LiveKit (`mixWithOthers`, never taking the audio session). Everything else (frames, looping
  cosmetics) is silent: `SvgaMovieCache` drops audio unless retained `withAudio`. The room's
  speaker toggle (`roomAudioOn`) disables remote audio tracks and mutes effects on this device.

## Platform moderators (`modules/moderation`)

- **Who:** app users with `users.platformModerator` (`{since, by}`), granted and revoked by
  admins with `moderators.manage` (user page, or Community → Platform moderators; audited as
  `user.platform_moderator`). The flag never gives dashboard access. `requireAuth` reloads
  the user on every request, so a revoke applies at once; it also calls
  `LiveService.dropHidden` so a stealth session can't outlive the role, and
  `LiveService.dropRoomAdmin` so it leaves no room-admin role behind in any live.
- **Room admin everywhere:** a platform moderator who joins a live visibly is added to its
  `moderatorIds` (`addAutoAdmin`, announced once, token role `moderator`). A hidden one is not,
  because the admin list would give them away. Staff are never auto-admins.
- **One rule, in `authority.ts`:** `canModerateLive` = platform moderator **or** staff with
  `live.moderate` (the token claim, never the Mongo mirror); `canModerateUsers` likewise
  with `users.moderate`. `routes/live.ts actor()` uses it for every in-room moderation route,
  so support and finance staff no longer kick or delete chat. `/me.moderation` sends the
  same answer to the app (`MeModeration`); the app never re-derives it from a role name.
- **Protected accounts** (`isProtected`: staff or platform moderators): hosts, room admins
  and platform moderators can't remove, mute or delete the messages of one, or ban one, and a
  device cascade skips them. Only staff can (`target_protected`). Moderators and staff pass
  host room bans, blocks and the lock at `/join`.
- **Moderation panel** (`routes/moderator.ts`, `/v1/moderator/*`; app `/moderation`):
  search (short id, uid, name prefix; cursor-paged), ban for 1/7/30 days or until lifted
  with a 3–200 character reason (`assertClean`), unban, devices, a device-ban dry run and
  cascade (never the actor's own `X-Device-Id`), the hosts' live bans with Lift, and ending
  any live (`endReason: 'moderator'`). Bans are keyed by `Idempotency-Key` and capped per
  moderator per hour (`platformModerators.banRateLimitPerHour`, counted from audit rows).
  Every write is audited with `adminRole: 'platform_moderator'`. Only staff unban devices.
- In a room, anything a platform moderator or staff member does in a live they don't host
  (kick, ban, chat delete, seat actions, swap, YouTube, appointing admins) is audited
  (`auditOutsider`), even while they are one of its admins.
- **Stealth and self-stage** (both off by default, `platformModerators.stealthEnabled` /
  `selfStageEnabled`; staff never get them):
  - A platform moderator in the audience joins with a **hidden** LiveKit grant
    (`stealth: true`): no `bb.entry`, no join line, no count.
  - The hidden bit lives on the `room_presence` row, copied from the webhook's
    `permission.hidden`, so it survives a redeploy. Viewer counts, `viewers()` and the join
    announcement skip hidden rows.
  - LiveKit replaces the whole permission, so `updateParticipant` always states `hidden`
    (`syncParticipant` → `hiddenIn`): a role change elsewhere in the room never reveals a
    watching moderator. Only the host and guests are always visible: an admin role doesn't
    reveal one. Seated, they are visible; back in the audience, hidden again.
  - `POST /live/:id/platform-moderator/stage {onStage}` takes the lowest free seat without
    approval (the seat cap applies) or leaves it, and returns `hidden`. Taking the seat makes
    them a room admin; leaving it with stealth on takes them off `moderatorIds` quietly (a
    `moderator` packet without `user`, so no chat line) before the re-mint hides them.
  - Chat from a hidden moderator carries `mod: true` (set by the server); the app draws a
    MOD chip. Turning stealth off doesn't reveal someone already connected.

## YouTube music (`modules/youtube`)

- Every device plays the song through YouTube's official IFrame player, synced to the server
  state. Nothing is extracted or mixed into a microphone.
- `YouTubeService` is the only writer of `live_rooms.youtube` (`{ current, queue, rev }`). Each
  write is one update conditional on `youtube.rev`, then a full snapshot on `bb.youtube`.
  Clients keep the highest rev (`mergeYouTube`), and so does the room detail on join and poll.
- Host, room admins and staff control it (staff actions are audited). The client names only a
  video id, which is checked with the Data API (`ytRefusal`: blocked lists, embeddable, public,
  not live, not age-restricted, region, length) before it is accepted. Skips, removes and moves
  name their `qid`, so retries are no-ops.
- A song ends only when the server clock agrees: `POST /live/:id/youtube/ended` (anyone in the
  room, 3 s slack) or the `youtube.sweep` tick on `current.endsAt`. `endsAt` never leaves the server.
- Searches spend quota (100 of 10,000 daily units): they are cached in `youtube_cache` and rate
  limited. A pasted link or bare id costs one lookup. The API is behind `infra/youtube.ts`
  (`FakeYouTube` in tests).
- Off unless `YOUTUBE_API_KEY` is set and `features.youtubeEnabled` is on. Rules are the private
  `youtube` config key. The flag gates starting a song, never stopping one.
- App: `LiveYouTubeCard` (`features/live/youtube_player.dart`) wraps `assets/youtube/player.html`
  in `webview_flutter`, loaded with base URL `https://$LINK_HOST/` so YouTube accepts the embed
  (error 153 otherwise). The player is at least 200×200, never takes touches, and never plays
  hidden, in the background or in the mini-player (it lives on the room screen only). It follows
  the room speaker toggle. Controls live in `YouTubeSheet`.

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

## Share links

- `DEEP_LINK_ROUTES` (`packages/shared`) is the contract: `https://<LINK_HOST>/<prefix>/<id>`.
  Adding a kind touches it, `modules/share` (preview), the app's `DeepLink` and the Android
  manifest prefixes; `app/test/deep_link_test.dart` checks the prefixes.
- `link-web` serves the `.well-known` files and the preview page. It reads the anonymous
  `GET /v1/share/preview/:kind/:id`, which is mounted before the global `/v1` limit and limited
  per visitor when `LINK_SERVICE_KEY` matches. Never serve a placeholder AASA.
- In the app, links and push taps go through `pendingRouteProvider` and `_dispatchPending`
  (`app.dart`), which waits for sign-in and the boot screens. Never `router.push` them directly.
  Flutter's own deep linking is off on both platforms (`DeepLinkService` handles them).
- `LINK_HOST` is one dart-define for Dart and the Android manifest. On iOS it is the Runner
  `LINK_HOST` build setting.

## Content moderation (SightGuard)

- Setup and the channel table are in `docs/sightguard.md`. It is off unless `SIGHTGUARD_ENABLED`.
  The SDK is behind `infra/sightguard.ts` (`FakeSightGuard` in tests) and is vendored as
  `backend/vendor/*.tgz`.
- Policy lives in `SightGuardService` only.
  - Text and most images fail **open**.
  - Avatars and live covers/backgrounds fail **closed**, with 503 `moderation_unavailable`.
  - A reject is 422 `content_rejected`.
  - The word filter (`assertClean`) still runs first.
- Uploads never pass through the API, so images are checked **by URL** when the URL is saved.
  Profile and room fields are checked only when they change. Platform `admin/` assets are skipped.
- A `review` verdict publishes now. Each check sends a `ContentRef` (ids allocated *before* the
  check) as metadata, so a later `review.completed` or `video.completed` reject can undo exactly
  that content. A new moderated entry point needs a ref type and an undo case in
  `SightGuardEventsService`.
- Webhooks (`POST /v1/webhooks/sightguard`) are deduped by the `sightguard_events` insert. A
  failed handler drops the row so the retry runs. Undo and room actions are conditional updates,
  so replaying them is safe.
- Live actions go through `LiveService.system*`, which uses actor `system` and writes
  `AuditService.recordSystem`. The host is never evicted (their live is ended, `endReason:
  'moderation'`). In a PK, the opponent's violation applies to the opponent's own room. A host
  seat never gets a mute flag, because nothing could clear it.
- Bans need `SIGHTGUARD_AUTO_BAN`, and staff are never auto-banned. Supervision start/end and
  video submits are `sightguard.*` jobs, so they never block or fail the user action.

## Realtime & jobs

- Socket.IO namespaces: `/` (personal events and the live directory) and `/games`.
- `wallet:updated` (`{ reason, diamonds }`) goes to every user whose diamonds moved, once
  per transaction after commit (`WalletService.track`). The app applies `diamonds` at once
  and debounces a full `/me` refresh.
- Wallets are public. The profile endpoint (`GET /users/:uid`) sends `diamonds`, and a
  seated user's balance rides `bb.seats`. Stars are display-only: one per
  `app.diamondsPerStar` (default 100,000), exposed through `/config/app`.
- Gift banner: after commit, `GiftsService.announce` broadcasts `gift:announcement` to every
  app socket for gifts worth at least `live.giftBannerMinDiamonds` (0 = all). It never fails
  the gift. The app shows it only in a live room (`GiftBannerOverlay`: dedupes by id, keeps
  the newest 20 waiting). Sockets join
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
- `flutter_webrtc` is vendored in `app/third_party/flutter_webrtc` (via `dependency_overrides`)
  with an Android patch: an exception in a native `PeerConnection.Observer` callback aborts
  the process. Bump it together with `livekit_client`, re-apply the patch, and read its
  `PATCHES.md` first.
- Camera filters (Whitening & Beautify, the default, plus colour looks) run natively on the
  capture track in the local plugin `app/plugins/bb_camera_filter` (Android GL, iOS Core
  Image), so preview, viewers and PK forwarding all get the same picture. The catalogue is
  `lib/features/live/camera_filters.dart`, and choices persist via `CameraFilterPrefs`.
  Capture restarts make a new native track (publish, camera back on, flip, rejoin): re-apply
  after each, and `CameraFilterChannel.clear` before the camera stops. On Android,
  `LocalVideoTrack` releases frames a processor returns, so a processor must never release
  its own output.
- Define providers at top level. A provider created inside `build()` is a new provider every
  frame.
- `flutter analyze` must be clean and `dart format` stable. Both are enforced in CI.

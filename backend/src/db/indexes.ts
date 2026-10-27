import type { IndexDescription } from 'mongodb';
import type { Collections, Database } from './mongo.js';

/**
 * Every index the application relies on. Several are load-bearing invariants rather than
 * performance hints — they are what make concurrent writes safe:
 *
 * - `users.shortId` unique — public ids never collide.
 * - `live_rooms.hostId` partial-unique on `status: 'live'` — one live room per host.
 * - `gift_transactions.idempotencyKey` unique — a retried gift never double-charges.
 * - `pk_battles.participantUids` partial-unique on `pkLive: true` — one battle per host.
 * - `game_bets.idempotencyKey`, `recharges.idempotencyKey`, `withdrawals.idempotencyKey` unique.
 */
export const INDEXES: { [K in keyof Collections]?: IndexDescription[] } = {
  users: [
    { key: { shortId: 1 }, unique: true },
    { key: { displayNameLower: 1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { email: 1 }, sparse: true },
    { key: { phone: 1 }, sparse: true },
    { key: { isAgent: 1 }, partialFilterExpression: { isAgent: true } },
    { key: { adminRole: 1 }, partialFilterExpression: { adminRole: { $type: 'string' } } },
    { key: { 'level.level': -1 } },
    { key: { agencyId: 1 }, partialFilterExpression: { agencyId: { $type: 'objectId' } } },
  ],
  follows: [
    { key: { followerId: 1, followeeId: 1 }, unique: true },
    { key: { followeeId: 1, createdAt: -1 } },
    { key: { followerId: 1, createdAt: -1 } },
  ],
  blocks: [{ key: { blockerId: 1, blockedId: 1 }, unique: true }, { key: { blockedId: 1 } }],
  liveRooms: [
    {
      key: { hostId: 1 },
      unique: true,
      partialFilterExpression: { status: 'live' },
      name: 'one_live_room_per_host',
    },
    { key: { livekitRoom: 1 }, unique: true },
    { key: { status: 1, type: 1, viewerCount: -1 } },
    { key: { status: 1, lastHeartbeatAt: 1 } },
    { key: { hostId: 1, startedAt: -1 } },
  ],
  roomPresence: [{ key: { roomId: 1, identity: 1 }, unique: true }],
  roomBans: [
    { key: { hostId: 1, userId: 1 }, unique: true },
    {
      key: { until: 1 },
      expireAfterSeconds: 0,
      partialFilterExpression: { until: { $type: 'date' } },
    },
  ],
  seatRequests: [
    {
      key: { roomId: 1, userId: 1, kind: 1 },
      unique: true,
      partialFilterExpression: { status: 'pending' },
    },
    { key: { status: 1, expiresAt: 1 } },
  ],
  liveMessages: [
    { key: { roomId: 1, createdAt: -1 } },
    // Room chat is ephemeral: kept a week for replies and reports, then dropped.
    { key: { createdAt: 1 }, expireAfterSeconds: 7 * 86_400 },
  ],
  gifts: [{ key: { active: 1, category: 1, sortOrder: 1 } }],
  giftTransactions: [
    { key: { idempotencyKey: 1 }, unique: true },
    { key: { senderId: 1, createdAt: -1 } },
    { key: { 'receivers.userId': 1, createdAt: -1 } },
    { key: { roomId: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
  ledger: [
    { key: { userId: 1, createdAt: -1 } },
    { key: { reason: 1, createdAt: -1 } },
    { key: { refId: 1 } },
  ],
  recharges: [
    { key: { idempotencyKey: 1 }, unique: true },
    { key: { userId: 1, createdAt: -1 } },
    { key: { agentId: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
  rechargePackages: [{ key: { sku: 1 }, unique: true }],
  vipPackages: [{ key: { tier: 1 }, unique: true }],
  cosmetics: [{ key: { type: 1, active: 1, sortOrder: 1 } }],
  userCosmetics: [
    { key: { userId: 1, cosmeticId: 1 }, unique: true },
    { key: { userId: 1, type: 1, expiresAt: -1 } },
  ],
  agencies: [{ key: { ownerId: 1 }, unique: true }, { key: { name: 1 } }],
  agencyMembers: [{ key: { userId: 1 }, unique: true }, { key: { agencyId: 1, periodBeans: -1 } }],
  agencyRequests: [
    { key: { userId: 1 }, unique: true, partialFilterExpression: { status: 'pending' } },
    { key: { agencyId: 1, status: 1, createdAt: -1 } },
  ],
  agencyPeriods: [
    { key: { agencyId: 1, periodKey: 1, userId: 1 }, unique: true },
    { key: { userId: 1, periodKey: -1 } },
  ],
  withdrawals: [
    { key: { idempotencyKey: 1 }, unique: true },
    { key: { userId: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    {
      key: { userId: 1 },
      unique: true,
      partialFilterExpression: { status: 'pending' },
      name: 'one_pending_withdrawal_per_user',
    },
  ],
  conversations: [{ key: { key: 1 }, unique: true }, { key: { participants: 1, updatedAt: -1 } }],
  messages: [
    { key: { conversationId: 1, createdAt: -1 } },
    {
      key: { conversationId: 1, senderId: 1, clientId: 1 },
      unique: true,
      partialFilterExpression: { clientId: { $type: 'string' } },
    },
  ],
  feedPosts: [
    { key: { status: 1, createdAt: -1 } },
    { key: { status: 1, score: -1 } },
    { key: { authorId: 1, createdAt: -1 } },
  ],
  feedComments: [{ key: { postId: 1, createdAt: -1 } }],
  feedLikes: [{ key: { postId: 1, userId: 1 }, unique: true }],
  notifications: [
    { key: { userId: 1, createdAt: -1 } },
    { key: { userId: 1, readAt: 1 } },
    { key: { createdAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 90 },
  ],
  announcements: [{ key: { createdAt: -1 } }],
  pushTokens: [
    { key: { userId: 1 } },
    { key: { updatedAt: 1 }, expireAfterSeconds: 60 * 60 * 24 * 120 },
  ],
  reports: [
    { key: { status: 1, createdAt: -1 } },
    { key: { targetType: 1, targetId: 1 } },
    {
      key: { reporterId: 1, targetType: 1, targetId: 1 },
      unique: true,
      partialFilterExpression: { status: 'open' },
    },
  ],
  devices: [{ key: { userId: 1, deviceId: 1 }, unique: true }, { key: { deviceId: 1 } }],
  pkBattles: [
    {
      key: { participantUids: 1 },
      unique: true,
      partialFilterExpression: { pkLive: true },
      name: 'one_live_pk_per_host',
    },
    { key: { status: 1, inviteExpiresAt: 1 } },
    { key: { status: 1, roundState: 1, endsAt: 1 } },
    { key: { status: 1, roundState: 1, pausedUntil: 1 } },
    { key: { 'hosts.roomId': 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
  pkContributions: [
    { key: { battleId: 1, hostUid: 1, userId: 1 }, unique: true },
    { key: { battleId: 1, hostUid: 1, score: -1 } },
  ],
  gameRounds: [
    { key: { game: 1, roundNo: -1 }, unique: true },
    {
      key: { game: 1 },
      unique: true,
      partialFilterExpression: { status: { $in: ['betting', 'locked'] } },
      name: 'one_open_round_per_game',
    },
    { key: { status: 1, settlesAt: 1 } },
  ],
  gameBets: [
    { key: { idempotencyKey: 1 }, unique: true },
    { key: { roundId: 1, userId: 1 } },
    { key: { userId: 1, createdAt: -1 } },
    { key: { roundId: 1, status: 1 } },
  ],
  banners: [{ key: { placement: 1, active: 1, sortOrder: 1 } }],
  idempotency: [{ key: { createdAt: 1 }, expireAfterSeconds: 7 * 86400 }],
  auditLogs: [
    { key: { createdAt: -1 } },
    { key: { adminId: 1, createdAt: -1 } },
    { key: { targetType: 1, targetId: 1 } },
  ],
};

export async function ensureIndexes(database: Database): Promise<void> {
  for (const [name, specs] of Object.entries(INDEXES)) {
    if (!specs?.length) continue;
    await database.col[name as keyof Collections].createIndexes(specs);
  }
}

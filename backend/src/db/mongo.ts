import {
  MongoClient,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type TransactionOptions,
} from 'mongodb';
import type * as S from './schema.js';

export interface Collections {
  users: Collection<S.UserDoc>;
  counters: Collection<S.CounterDoc>;
  follows: Collection<S.FollowDoc>;
  blocks: Collection<S.BlockDoc>;
  liveRooms: Collection<S.LiveRoomDoc>;
  roomPresence: Collection<S.RoomPresenceDoc>;
  roomBans: Collection<S.RoomBanDoc>;
  seatRequests: Collection<S.SeatRequestDoc>;
  liveMessages: Collection<S.LiveMessageDoc>;
  gifts: Collection<S.GiftDoc>;
  giftTransactions: Collection<S.GiftTransactionDoc>;
  ledger: Collection<S.LedgerDoc>;
  recharges: Collection<S.RechargeDoc>;
  rechargePackages: Collection<S.RechargePackageDoc>;
  levelConfigs: Collection<S.LevelConfigDoc>;
  vipPackages: Collection<S.VipPackageDoc>;
  cosmetics: Collection<S.CosmeticDoc>;
  userCosmetics: Collection<S.UserCosmeticDoc>;
  agencies: Collection<S.AgencyDoc>;
  agencyMembers: Collection<S.AgencyMemberDoc>;
  agencyRequests: Collection<S.AgencyRequestDoc>;
  agencyPeriods: Collection<S.AgencyPeriodDoc>;
  withdrawals: Collection<S.WithdrawalDoc>;
  conversations: Collection<S.ConversationDoc>;
  messages: Collection<S.MessageDoc>;
  feedPosts: Collection<S.FeedPostDoc>;
  feedComments: Collection<S.FeedCommentDoc>;
  feedLikes: Collection<S.FeedLikeDoc>;
  notifications: Collection<S.NotificationDoc>;
  announcements: Collection<S.AnnouncementDoc>;
  pushTokens: Collection<S.PushTokenDoc>;
  reports: Collection<S.ReportDoc>;
  devices: Collection<S.DeviceDoc>;
  deviceBans: Collection<S.DeviceBanDoc>;
  pkBattles: Collection<S.PkBattleDoc>;
  pkContributions: Collection<S.PkContributionDoc>;
  games: Collection<S.GameDoc>;
  gameRounds: Collection<S.GameRoundDoc>;
  gameBets: Collection<S.GameBetDoc>;
  banners: Collection<S.BannerDoc>;
  appConfig: Collection<S.AppConfigDoc>;
  auditLogs: Collection<S.AuditLogDoc>;
  idempotency: Collection<S.IdempotencyDoc>;
  migrations: Collection<S.MigrationDoc>;
}

const NAMES: Record<keyof Collections, string> = {
  users: 'users',
  counters: 'counters',
  follows: 'follows',
  blocks: 'blocks',
  liveRooms: 'live_rooms',
  roomPresence: 'room_presence',
  roomBans: 'room_bans',
  seatRequests: 'seat_requests',
  liveMessages: 'live_messages',
  gifts: 'gifts',
  giftTransactions: 'gift_transactions',
  ledger: 'ledger',
  recharges: 'recharges',
  rechargePackages: 'recharge_packages',
  levelConfigs: 'level_configs',
  vipPackages: 'vip_packages',
  cosmetics: 'cosmetics',
  userCosmetics: 'user_cosmetics',
  agencies: 'agencies',
  agencyMembers: 'agency_members',
  agencyRequests: 'agency_requests',
  agencyPeriods: 'agency_periods',
  withdrawals: 'withdrawals',
  conversations: 'conversations',
  messages: 'messages',
  feedPosts: 'feed_posts',
  feedComments: 'feed_comments',
  feedLikes: 'feed_likes',
  notifications: 'notifications',
  announcements: 'announcements',
  pushTokens: 'push_tokens',
  reports: 'reports',
  devices: 'devices',
  deviceBans: 'device_bans',
  pkBattles: 'pk_battles',
  pkContributions: 'pk_contributions',
  games: 'games',
  gameRounds: 'game_rounds',
  gameBets: 'game_bets',
  banners: 'banners',
  appConfig: 'app_config',
  auditLogs: 'audit_logs',
  idempotency: 'idempotency_keys',
  migrations: 'migrations',
};

export interface Database {
  client: MongoClient;
  db: Db;
  col: Collections;
  /**
   * Run `fn` inside a multi-document transaction, retrying on transient errors.
   * Everything that moves money MUST go through here.
   */
  withTransaction<T>(
    fn: (session: ClientSession) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const TXN_DEFAULTS: TransactionOptions = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary',
};

export function wrapDb(client: MongoClient, dbName: string): Database {
  const db = client.db(dbName);
  const col = Object.fromEntries(
    Object.entries(NAMES).map(([k, name]) => [k, db.collection<Document>(name)]),
  ) as unknown as Collections;

  return {
    client,
    db,
    col,
    async withTransaction(fn, opts) {
      const session = client.startSession();
      try {
        let result: Awaited<ReturnType<typeof fn>> | undefined;
        await session.withTransaction(
          async (s) => {
            result = await fn(s);
          },
          { ...TXN_DEFAULTS, ...opts },
        );
        return result as Awaited<ReturnType<typeof fn>>;
      } finally {
        await session.endSession();
      }
    },
    async ping() {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.close(),
  };
}

export async function connectMongo(uri: string, dbName: string): Promise<Database> {
  const client = new MongoClient(uri, {
    maxPoolSize: 50,
    minPoolSize: 2,
    retryWrites: true,
    serverSelectionTimeoutMS: 10_000,
    appName: 'bigboss-backend',
  });
  await client.connect();
  return wrapDb(client, dbName);
}

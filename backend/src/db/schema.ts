import type { ObjectId } from 'mongodb';
import type {
  AdminRole,
  AnimationFormat,
  CosmeticType,
  Currency,
  GameKey,
  LedgerReason,
  MessageType,
  PkStatus,
  ReportStatus,
  ReportTarget,
  RoomStatus,
  RoomType,
  UserStatus,
  WithdrawalStatus,
} from '@bigboss/shared';

/**
 * MongoDB document shapes. MongoDB is the single source of truth — there is no Firestore
 * mirror. Money is stored as integer counts of diamonds/beans; never floats.
 */

export interface UserDoc {
  /** Firebase Auth uid. */
  _id: string;
  /** Public, human-friendly numeric id shown in the app ("ID 10023456"). Unique. */
  shortId: string;
  displayName: string;
  /** Lower-cased display name for prefix search. */
  displayNameLower: string;
  avatarUrl: string | null;
  bio: string;
  gender: 'male' | 'female' | 'other' | null;
  birthday: Date | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  status: UserStatus;
  ban: { reason: string; until: Date | null; by: string; at: Date } | null;
  adminRole: AdminRole | null;
  isAgent: boolean;
  wallet: { diamonds: number; beans: number; agentStock: number };
  stats: {
    followers: number;
    following: number;
    /** Diamonds credited through recharges (agent/admin/IAP). Feeds level points 1:1. */
    totalRecharged: number;
    /** Diamond value of gifts received. Feeds level points × receivedWeight. */
    totalReceived: number;
    /** Diamonds spent on gifts. Display only — never feeds level. */
    totalSent: number;
    liveSeconds: number;
  };
  level: { level: number; points: number };
  vip: { tier: number; expiresAt: Date | null };
  equipped: {
    frameId: ObjectId | null;
    entryAnimationId: ObjectId | null;
    frameUrl: string | null;
  };
  agencyId: ObjectId | null;
  liveRoomId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
}

export interface CounterDoc {
  _id: string;
  seq: number;
}

export interface FollowDoc {
  _id?: ObjectId;
  followerId: string;
  followeeId: string;
  createdAt: Date;
}

export interface BlockDoc {
  _id?: ObjectId;
  blockerId: string;
  blockedId: string;
  createdAt: Date;
}

export interface SeatDoc {
  index: number;
  userId: string | null;
  muted: boolean;
  locked: boolean;
}

export interface LiveRoomDoc {
  _id: ObjectId;
  hostId: string;
  type: RoomType;
  status: RoomStatus;
  title: string;
  coverUrl: string | null;
  tags: string[];
  country: string | null;
  /** LiveKit room name. `bb_<hostId>_<ms>`; unique per session. */
  livekitRoom: string;
  viewerCount: number;
  peakViewers: number;
  /** Beans the host earned in this session (after commission). */
  giftBeans: number;
  giftCount: number;
  moderatorIds: string[];
  seats: SeatDoc[];
  pkBattleId: ObjectId | null;
  backgroundUrl: string | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
  endedAt: Date | null;
  endReason: 'host' | 'admin' | 'stale' | 'webhook' | 'banned' | null;
  endedBy: string | null;
}

/** One row per LiveKit participant currently in a room, maintained from webhooks. */
export interface RoomPresenceDoc {
  _id?: ObjectId;
  roomId: ObjectId;
  identity: string;
  joinedAt: Date;
}

export interface RoomBanDoc {
  _id?: ObjectId;
  hostId: string;
  userId: string;
  until: Date | null;
  by: string;
  createdAt: Date;
}

export interface SeatRequestDoc {
  _id?: ObjectId;
  roomId: ObjectId;
  userId: string;
  kind: 'request' | 'invite';
  status: 'pending' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
  expiresAt: Date;
  createdAt: Date;
}

export interface GiftDoc {
  _id: ObjectId;
  name: string;
  price: number;
  iconUrl: string;
  animationUrl: string | null;
  animationFormat: AnimationFormat;
  category: string;
  sortOrder: number;
  active: boolean;
  vipTierRequired: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GiftTransactionDoc {
  _id: ObjectId;
  senderId: string;
  /** Client-supplied, scoped to the sender: `${senderId}:${key}`. Unique. */
  idempotencyKey: string;
  giftId: ObjectId;
  giftName: string;
  unitPrice: number;
  quantity: number;
  receivers: {
    userId: string;
    cost: number;
    beans: number;
    platformFee: number;
    agencyFee: number;
    agencyId: ObjectId | null;
  }[];
  totalCost: number;
  roomId: ObjectId | null;
  pkBattleId: ObjectId | null;
  createdAt: Date;
}

export interface LedgerDoc {
  _id?: ObjectId;
  userId: string;
  currency: Currency;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  refId: string | null;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

export interface RechargeDoc {
  _id?: ObjectId;
  userId: string;
  diamonds: number;
  source: 'agent' | 'admin' | 'iap';
  agentId: string | null;
  adminId: string | null;
  note: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

export interface RechargePackageDoc {
  _id: ObjectId;
  sku: string;
  diamonds: number;
  bonusDiamonds: number;
  priceUsd: number;
  active: boolean;
  sortOrder: number;
}

export interface LevelConfigDoc {
  /** Level number, 1…100. */
  _id: number;
  pointsRequired: number;
  name: string;
  color: string;
  iconUrl: string | null;
}

export interface VipPackageDoc {
  _id: ObjectId;
  tier: number;
  name: string;
  priceDiamonds: number;
  durationDays: number;
  perks: string[];
  badgeUrl: string | null;
  frameUrl: string | null;
  active: boolean;
  sortOrder: number;
}

export interface CosmeticDoc {
  _id: ObjectId;
  type: CosmeticType;
  name: string;
  assetUrl: string;
  previewUrl: string | null;
  animationFormat: AnimationFormat;
  priceDiamonds: number;
  durationDays: number;
  vipTierRequired: number;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
}

export interface UserCosmeticDoc {
  _id?: ObjectId;
  userId: string;
  cosmeticId: ObjectId;
  type: CosmeticType;
  expiresAt: Date;
  acquiredAt: Date;
}

export interface AgencyDoc {
  _id: ObjectId;
  name: string;
  ownerId: string;
  logoUrl: string | null;
  /** Fraction of each gift's value the agency owner earns, e.g. 0.05. */
  commissionRate: number;
  status: 'active' | 'suspended';
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgencyMemberDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  joinedAt: Date;
  /** Current accounting period, "YYYY-MM" in the agency timezone. */
  periodKey: string;
  periodBeans: number;
  periodLiveSeconds: number;
}

export interface AgencyRequestDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: Date;
  decidedAt: Date | null;
}

export interface AgencyPeriodDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  periodKey: string;
  beans: number;
  liveSeconds: number;
  closedAt: Date;
}

export interface WithdrawalDoc {
  _id: ObjectId;
  userId: string;
  beans: number;
  amountUsd: number;
  method: 'bank' | 'mobile_wallet' | 'paypal' | 'other';
  account: Record<string, string>;
  status: WithdrawalStatus;
  idempotencyKey: string;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface ConversationDoc {
  _id: ObjectId;
  /** Sorted pair of uids joined with ":" — unique. */
  key: string;
  participants: [string, string];
  lastMessage: { text: string; senderId: string; type: MessageType; at: Date } | null;
  unread: Record<string, number>;
  updatedAt: Date;
  createdAt: Date;
}

export interface MessageDoc {
  _id: ObjectId;
  conversationId: ObjectId;
  senderId: string;
  type: MessageType;
  text: string | null;
  mediaUrl: string | null;
  clientId: string | null;
  deletedFor: string[];
  createdAt: Date;
}

export interface FeedPostDoc {
  _id: ObjectId;
  authorId: string;
  text: string;
  media: { url: string; type: 'image' | 'video'; width?: number; height?: number }[];
  likeCount: number;
  commentCount: number;
  status: 'active' | 'hidden' | 'removed';
  score: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedCommentDoc {
  _id: ObjectId;
  postId: ObjectId;
  authorId: string;
  text: string;
  status: 'active' | 'removed';
  createdAt: Date;
}

export interface FeedLikeDoc {
  _id?: ObjectId;
  postId: ObjectId;
  userId: string;
  createdAt: Date;
}

export interface NotificationDoc {
  _id: ObjectId;
  userId: string;
  type: 'system' | 'follow' | 'gift' | 'live' | 'like' | 'comment' | 'agency' | 'withdrawal';
  title: string;
  body: string;
  data: Record<string, string>;
  readAt: Date | null;
  createdAt: Date;
}

export interface AnnouncementDoc {
  _id: ObjectId;
  title: string;
  body: string;
  imageUrl: string | null;
  audience: 'all' | 'hosts' | 'agents' | 'vip';
  status: 'queued' | 'sending' | 'sent' | 'failed';
  sentBy: string;
  stats: { recipients: number; pushed: number; failed: number };
  createdAt: Date;
  completedAt: Date | null;
}

export interface PushTokenDoc {
  /** The FCM registration token itself. */
  _id: string;
  userId: string;
  platform: 'android' | 'ios' | 'web';
  updatedAt: Date;
}

export interface ReportDoc {
  _id: ObjectId;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  details: string;
  status: ReportStatus;
  resolution: { by: string; action: string; note: string | null; at: Date } | null;
  createdAt: Date;
}

export interface DeviceDoc {
  _id?: ObjectId;
  userId: string;
  deviceId: string;
  platform: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface DeviceBanDoc {
  /** Normalised device id. */
  _id: string;
  reason: string;
  by: string;
  createdAt: Date;
}

export interface PkHost {
  uid: string;
  roomId: ObjectId;
  livekitRoom: string;
  score: number;
}

export interface PkBattleDoc {
  _id: ObjectId;
  status: PkStatus;
  /**
   * True while the battle is pending or active. A unique multikey index on
   * `participantUids` filtered by `pkLive: true` is the one-battle-per-host invariant;
   * every terminal write MUST unset it in the same update.
   */
  pkLive: boolean;
  participantUids: string[];
  hosts: [PkHost, PkHost];
  invitedBy: string;
  durationSec: number;
  inviteExpiresAt: Date;
  startedAt: Date | null;
  endsAt: Date | null;
  endedAt: Date | null;
  winnerUid: string | null;
  isDraw: boolean;
  endReason: 'timeout' | 'host_left' | 'admin' | 'forfeit' | null;
  createdAt: Date;
}

export interface PkContributionDoc {
  _id?: ObjectId;
  battleId: ObjectId;
  hostUid: string;
  userId: string;
  score: number;
}

export interface GameDoc {
  _id: GameKey;
  name: string;
  enabled: boolean;
  url: string;
  iconUrl: string | null;
  sortOrder: number;
  config: GameConfig;
  updatedAt: Date;
}

export interface GameConfig {
  bettingSeconds: number;
  revealSeconds: number;
  minBet: number;
  maxBet: number;
  /** Per-user cap on the sum of stakes in one round. */
  maxRoundStake: number;
  chips: number[];
  /** Outcome → payout multiplier (stake × multiplier is returned, stake included). */
  payouts: Record<string, number>;
  /** Outcome → relative weight for the RNG. */
  weights: Record<string, number>;
}

export interface GameRoundDoc {
  _id: ObjectId;
  game: GameKey;
  roundNo: number;
  status: 'betting' | 'locked' | 'settled';
  /** sha256(serverSeed) published at round start (commit). */
  serverSeedHash: string;
  /** Revealed only after settlement. */
  serverSeed: string;
  options: string[];
  totals: Record<string, number>;
  betCount: number;
  outcome: string | null;
  /** Game-specific reveal payload (e.g. dealt cards). */
  reveal: Record<string, unknown> | null;
  payoutTotal: number;
  bettingEndsAt: Date;
  settlesAt: Date;
  createdAt: Date;
  settledAt: Date | null;
}

export interface GameBetDoc {
  _id?: ObjectId;
  roundId: ObjectId;
  game: GameKey;
  userId: string;
  option: string;
  amount: number;
  payout: number;
  status: 'placed' | 'won' | 'lost' | 'refunded';
  idempotencyKey: string;
  createdAt: Date;
  settledAt: Date | null;
}

export interface BannerDoc {
  _id: ObjectId;
  title: string;
  imageUrl: string;
  linkUrl: string | null;
  placement: 'home' | 'live' | 'wallet' | 'games';
  sortOrder: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
}

export interface AppConfigDoc {
  _id: string;
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface AuditLogDoc {
  _id?: ObjectId;
  adminId: string;
  adminRole: AdminRole;
  action: string;
  targetType: string;
  targetId: string | null;
  payload: unknown;
  ip: string;
  createdAt: Date;
}

/** Generic write-once idempotency record for operations without their own unique key. */
export interface IdempotencyDoc {
  /** `${scope}:${uid}:${clientKey}` */
  _id: string;
  result: unknown;
  createdAt: Date;
}

export interface MigrationDoc {
  _id: string;
  appliedAt: Date;
}

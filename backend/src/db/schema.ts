import type { ObjectId } from 'mongodb';
import type {
  AdminRole,
  AgencyAuditAction,
  AgencyRole,
  AnimationFormat,
  BadgeBlendMode,
  CosmeticType,
  Currency,
  GameTxKind,
  GameTxStatus,
  LedgerReason,
  LiveEndReason,
  MessageType,
  PkEndReason,
  PkRoundState,
  PkStatus,
  ReportStatus,
  ReportTarget,
  RoomStatus,
  RoomType,
  UserStatus,
  WithdrawalStatus,
  YtItem,
  YtNowPlaying,
} from '@bigboss/shared';
import type { YtVideo } from '../infra/youtube.js';

/**
 * MongoDB document shapes. MongoDB is the single source of truth — there is no Firestore
 * mirror. Money is stored as integer counts of diamonds (and agent stock); never floats.
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
  /**
   * A platform moderator: an app user trusted to moderate from inside the app (no dashboard
   * access). Granted and revoked by admins with `moderators.manage`. Null/absent otherwise.
   */
  platformModerator?: { since: Date; by: string } | null;
  /**
   * Blocked from AsadSoft games by staff (`games.block`). Launch refuses, and every new stake
   * is refused at the wallet callback; wins, refunds and claw-backs still apply.
   */
  gamesBlock?: { at: Date; by: string; reason: string } | null;
  isAgent: boolean;
  wallet: { diamonds: number; agentStock: number };
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
  /**
   * The worn tier package (one at a time). `tier`/`expiresAt` are the package's tier and the
   * owned row's expiry; `badge` is copied from the package (re-synced when it changes). Only
   * `TierPackagesService` writes it. Readers go through `activeVipTier()`, so an expired slot
   * reads as none before the sweep clears it.
   */
  vip: {
    tier: number;
    expiresAt: Date | null;
    packageId?: ObjectId | null;
    badge?: TierBadgeDoc | null;
  };
  /**
   * What the user shows. `frameUrl`/`frameFormat`/`roomBackgroundUrl` are copied from the
   * equipped store item (kept in sync when that item changes). Per slot:
   * - `*VipTier` is 0 for an item the user owns, else the tier that lets them wear it unowned
   *   (`vipIncluded`), so a lapsed tier drops it at read time.
   * - `*ExpiresAt` is the ownership's expiry (null when worn through a tier), so an expired
   *   item drops at read time too, before `store.sweep` clears the slot.
   * Readers go through `resolveFrame()` / `resolveRoomBackground()` / `slotWearable()`, never
   * these fields directly.
   */
  equipped: {
    frameId: ObjectId | null;
    entryAnimationId: ObjectId | null;
    frameUrl: string | null;
    frameFormat?: AnimationFormat;
    frameVipTier?: number;
    frameExpiresAt?: Date | null;
    entryAnimationVipTier?: number;
    entryAnimationExpiresAt?: Date | null;
    roomBackgroundId?: ObjectId | null;
    roomBackgroundUrl?: string | null;
    roomBackgroundVipTier?: number;
    roomBackgroundExpiresAt?: Date | null;
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
  /** Mic muted by the host or a moderator. Enforced on the SFU, not just signalled. */
  muted: boolean;
  /** Camera turned off by the host or a moderator. */
  videoMuted: boolean;
  locked: boolean;
  /**
   * First time `live.sweep` found the seated guest missing from LiveKit. A second miss frees
   * the seat; being seen again clears it. Null/absent while present.
   */
  absentSince?: Date | null;
  /**
   * When the current occupant took the seat. Clients order the video stage by it, so guests
   * keep their join order and a late joiner lands last. Null on an empty seat; absent on
   * rooms started before it existed (clients fall back to the seat index).
   */
  seatedAt?: Date | null;
}

/** Frozen post-live summary, written once a settle window after the live ended. */
export interface LiveSummaryDoc {
  finalizedAt: Date;
  /** Every gift sent in the room, at full cost (host and guests). */
  roomDiamonds: number;
  giftCount: number;
  gifters: number;
  /** Cost of the gifts the host received (before fees). */
  hostDiamonds: number;
  /** Diamonds credited to the host for them (after fees). */
  hostEarnings: number;
  newFollowers: number;
  topGifters: { userId: string; diamonds: number; gifts: number }[];
  topGifts: { giftId: ObjectId; giftName: string; count: number; diamonds: number }[];
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
  /** Diamonds the host earned in this session (after commission). */
  giftDiamonds: number;
  giftCount: number;
  moderatorIds: string[];
  seats: SeatDoc[];
  /**
   * A seated guest shown in the host's (largest) stage spot, the host taking theirs. Set by
   * the host, a room admin or staff; cleared in `vacateSeatOf` when that guest leaves the
   * seat. Null/absent = normal layout.
   */
  swappedUid?: string | null;
  pkBattleId: ObjectId | null;
  /** Host's VIP tier when the session started or resumed; orders the Popular tab. */
  hostVipTier?: number;
  backgroundUrl: string | null;
  /**
   * The host's equipped store background, snapshotted at go-live and refreshed when they
   * equip or it lapses. Shown when `backgroundUrl` (set for this live) is empty.
   */
  decorBackgroundUrl?: string | null;
  /** No new viewers may join (staff, moderators and seated guests still can). */
  locked: boolean;
  /** scrypt hash (`salt:hash`, hex) of an optional numeric password that bypasses the lock. */
  passwordHash: string | null;
  startedAt: Date;
  lastHeartbeatAt: Date;
  endedAt: Date | null;
  endReason: LiveEndReason | null;
  endedBy: string | null;
  /** YouTube songs and their queue. Written only by `YouTubeService`. */
  youtube?: YouTubeStateDoc | null;
  /** LiveKit joins by viewers (a reconnect after leaving counts again). Absent on old rooms. */
  totalJoins?: number;
  /** Distinct viewers (deduped through `live_viewers`). Absent on old rooms. */
  uniqueViewers?: number;
  chatMessages?: number;
  reactions?: number;
  /** Set once by `LiveSummaryService` after the settle window; null/absent until then. */
  summary?: LiveSummaryDoc | null;
}

/** One row per (room, viewer): dedupes `live_rooms.uniqueViewers`. Expires after 90 days. */
export interface LiveViewerDoc {
  /** `${roomId}:${uid}` */
  _id: string;
  roomId: ObjectId;
  uid: string;
  createdAt: Date;
}

/** The song playing now, as stored: `endsAt` is server-only and read by `youtube.sweep`. */
export interface YtNowPlayingDoc extends YtNowPlaying {
  /** When the song ends on the server clock (ms) while playing, else null. */
  endsAt: number | null;
}

/** A live's YouTube music. Every write bumps `rev`; clients drop older snapshots. */
export interface YouTubeStateDoc {
  current: YtNowPlayingDoc | null;
  queue: YtItem[];
  rev: number;
}

/** One row per LiveKit participant currently in a room, maintained from webhooks. */
export interface RoomPresenceDoc {
  _id?: ObjectId;
  roomId: ObjectId;
  identity: string;
  joinedAt: Date;
  /**
   * A platform moderator connected with a hidden LiveKit grant (stealth). Copied from the
   * webhook's `permission.hidden`, so it survives a redeploy. Hidden rows are left out of the
   * viewer count, the viewer list and the join announcement. Cleared while they sit on stage.
   */
  hidden?: boolean;
}

export interface RoomBanDoc {
  _id?: ObjectId;
  hostId: string;
  userId: string;
  until: Date | null;
  by: string;
  createdAt: Date;
}

/** In-room chat, kept briefly so replies, deletion and reports can reference a message. */
export interface LiveMessageDoc {
  _id: ObjectId;
  roomId: ObjectId;
  userId: string;
  type: 'text' | 'voice' | 'gift';
  text: string;
  voice: { url: string; durationSec: number } | null;
  /** Set on `type: 'gift'` rows, whose `_id` is the gift transaction's. Absent on older rows. */
  gift?: LiveGiftMessage | null;
  replyTo: { id: string; userId: string; displayName: string; text: string } | null;
  createdAt: Date;
  deletedAt: Date | null;
}

export interface LiveGiftMessage {
  transactionId: string;
  giftId: string;
  name: string;
  iconUrl: string;
  quantity: number;
  totalCost: number;
  receivers: { id: string; displayName: string }[];
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
    /** Credited to the receiver: cost − platformFee − agencyFee. */
    diamonds: number;
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
  /** Level number, 1…MAX_LEVEL (500). */
  _id: number;
  pointsRequired: number;
  name: string;
  color: string;
  iconUrl: string | null;
}

export interface TierBadgeDoc {
  imageUrl: string | null;
  svgaUrl: string | null;
  mp4Url: string | null;
  blendMode: BadgeBlendMode;
}

/** A tier package: badge artwork sold for `durationDays` that puts its wearer in `tier`. */
export interface TierPackageDoc {
  _id: ObjectId;
  /** 1 VIP, 2 VVIP, 3 Crown, 4 King. Never changes after creation. */
  tier: number;
  name: string;
  priceDiamonds: number;
  durationDays: number;
  badge: TierBadgeDoc;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A user's hold on a tier package. Buying it again extends `expiresAt`. */
export interface UserTierPackageDoc {
  _id?: ObjectId;
  userId: string;
  packageId: ObjectId;
  tier: number;
  acquiredAt: Date;
  expiresAt: Date;
  source: 'purchase' | 'admin';
  grantedBy: string | null;
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
  /** Holders of `vipTierRequired`+ wear it free; it is not sold. Absent on older rows. */
  vipIncluded?: boolean;
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
  /** How the latest extension came about. Absent on rows older than this field. */
  source?: 'purchase' | 'admin';
  /** Admin uid behind the latest admin grant, else null. */
  grantedBy?: string | null;
}

export interface AgencyDoc {
  _id: ObjectId;
  /** Public agency code, `HA-XXXXXXXX`. Unique. */
  code: string;
  name: string;
  ownerId: string;
  logoUrl: string | null;
  /** Fraction of each gift's value the agency owner earns, e.g. 0.05. */
  commissionRate: number;
  status: 'active' | 'suspended';
  memberCount: number;
  /**
   * Agency-wide counters for the current month (`key` = "YYYY-MM" in the agency timezone),
   * moved inside the gift transaction alongside the member's. A stale `key` means zero.
   */
  period: { key: string; diamonds: number; liveSeconds: number; commission: number; gifts: number };
  lifetime: { diamonds: number; liveSeconds: number; commission: number; gifts: number };
  createdAt: Date;
  updatedAt: Date;
}

export interface AgencyMemberDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  /** Agency admins help the owner run the agency (requests, invitations, plain hosts). */
  role: AgencyRole;
  /** A locked host cannot leave on their own; only a platform admin can unlock them. */
  locked: boolean;
  /** Daily live-time goal the owner set for this host, in minutes. */
  dailyTargetMinutes: number | null;
  joinedAt: Date;
  /** Current accounting period, "YYYY-MM" in the agency timezone. */
  periodKey: string;
  periodDiamonds: number;
  periodLiveSeconds: number;
  /** Totals since this membership started. */
  lifetimeDiamonds: number;
  lifetimeLiveSeconds: number;
}

export interface AgencyRequestDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: Date;
  decidedAt: Date | null;
}

/** Owner/agency-admin invitation to a host. Joining needs the host's consent. */
export interface AgencyInvitationDoc {
  _id: ObjectId;
  agencyId: ObjectId;
  userId: string;
  invitedBy: string;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}

export interface AgencyPeriodDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  periodKey: string;
  diamonds: number;
  liveSeconds: number;
  closedAt: Date;
}

/** One row per (agency, host, day in the agency timezone). Feeds dashboards and targets. */
export interface AgencyDailyStatDoc {
  _id?: ObjectId;
  agencyId: ObjectId;
  userId: string;
  /** "YYYY-MM-DD" in the agency timezone. */
  dayKey: string;
  diamonds: number;
  gifts: number;
  commission: number;
  liveSeconds: number;
}

export interface AgencyAuditDoc {
  _id: ObjectId;
  agencyId: ObjectId;
  /** uid of the owner, agency admin, host or platform admin who acted, or `system`. */
  actorId: string;
  action: AgencyAuditAction;
  targetUserId: string | null;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export interface WithdrawalDoc {
  _id: ObjectId;
  userId: string;
  diamonds: number;
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
  /** Set when moderation removed the message for both sides. Absent on older rows. */
  removedAt?: Date | null;
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
  /** Total across all rounds. */
  score: number;
  roundScore: number;
  roundsWon: number;
}

export interface PkRoundDoc {
  round: number;
  scores: [number, number];
  winnerUid: string | null;
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
  /** Length of each round. */
  durationSec: number;
  /** 1-based; 0 while pending. */
  round: number;
  maxRounds: number;
  roundState: PkRoundState | null;
  scoringOpensAt: Date | null;
  /** Deadline of the current round. */
  endsAt: Date | null;
  /** Deadline of the between-rounds pause. */
  pausedUntil: Date | null;
  rounds: PkRoundDoc[];
  inviteExpiresAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  winnerUid: string | null;
  isDraw: boolean;
  endReason: PkEndReason | null;
  createdAt: Date;
}

export interface PkContributionDoc {
  _id?: ObjectId;
  battleId: ObjectId;
  hostUid: string;
  userId: string;
  score: number;
}

/**
 * An AsadSoft game. Provider fields are refreshed by the catalogue sync; the rest are our
 * own controls, edited in the admin and never touched by a sync.
 */
export interface GameCatalogDoc {
  /** AsadSoft `gameId`. */
  _id: string;
  provider: {
    name: string;
    category: string;
    thumbnailUrl: string | null;
    sortOrder: number;
    /** False once the provider stops listing it for us (removed, or access revoked). */
    available: boolean;
    syncedAt: Date;
  };
  /** New games arrive off: an admin opts each one in. */
  enabled: boolean;
  /** Offered in the live room's Games sheet. */
  liveRoom: boolean;
  /** Null: the global `games.minLevel` applies. */
  minLevel: number | null;
  sortOrder: number;
  displayName: string | null;
  iconUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * One AsadSoft wallet call (`/debit` or `/credit`), keyed by its `txId`: the unique `_id` IS
 * the idempotency. Also holds refusals (so a retry is refused identically) and tombstones
 * (a reversal that arrived before its original, which is then refused).
 */
export interface GameWalletTxDoc {
  _id: string;
  type: 'debit' | 'credit';
  kind: GameTxKind;
  status: GameTxStatus;
  uid: string;
  gameId: string | null;
  roundId: string | null;
  gameRoundId: string | null;
  sessionId: string | null;
  refTxId: string | null;
  /** On a reversed row: the txId that reversed it. On a tombstone: the reversal that left it. */
  reversedBy?: string | null;
  requested: number;
  applied: number;
  shortfall: number;
  balanceAfter: number | null;
  code: string | null;
  httpStatus: number;
  description: string | null;
  currency: string | null;
  /** The day (report timezone) and game this movement counts under in the stats. */
  statsDay: string | null;
  createdAt: Date;
}

/** Stats counters, in diamonds. Reversals are netted out of the kind they reverse. */
export interface GameCounters {
  stakes: number;
  stakeCount: number;
  wins: number;
  winCount: number;
  /** Loss cashback and wager rebates. */
  cashback: number;
  /** Stakes refunded or cancelled. */
  refunds: number;
  /** Wins (or withdrawals) clawed back. */
  reversals: number;
  transfersIn: number;
  transfersOut: number;
  otherDebits: number;
  otherCredits: number;
  /** Every diamond debited / credited (cash flow, on the day it moved). */
  debited: number;
  credited: number;
  /** stakes − wins − cashback: what the platform won from this player. */
  net: number;
}

/**
 * Per player, per game, per day (report timezone). Written in the same transaction as the
 * money, so the stats always reconcile to the wallet calls. Per-player rows (rather than one
 * row per game per day) keep concurrent stakes in a busy room from write-conflicting.
 */
export interface GamePlayerDayDoc extends GameCounters {
  /** `${day}:${uid}:${gameId}` */
  _id: string;
  day: string;
  uid: string;
  /** `_none` for movements without a game (transfers). */
  gameId: string;
  updatedAt: Date;
}

/** A player's lifetime games figures. */
export interface GameUserStatsDoc extends GameCounters {
  _id: string;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  lastGameId: string | null;
}

/**
 * A launched AsadSoft session. The token lets us end it (AsadSoft has no API-key route for
 * that) when a player is blocked or a game is turned off. Never returned by any route.
 */
export interface GameSessionDoc {
  _id: string;
  uid: string;
  gameId: string;
  token: string;
  inLive: boolean;
  createdAt: Date;
  expiresAt: Date;
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
  /**
   * The actor's uid; `system` for automated actions (SightGuard verdicts). Platform
   * moderators acting from the app are recorded with `adminRole: 'platform_moderator'`.
   */
  adminId: string;
  adminRole: AdminRole | 'system' | 'platform_moderator' | 'user';
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

/** A processed SightGuard webhook delivery. The unique `_id` (event id) is the dedupe guard. */
export interface SightGuardEventDoc {
  _id: string;
  type: string;
  receivedAt: Date;
}

/** A cached YouTube search page (`s:<hash>`) or video lookup (`v:<id>`). Holds no uid. */
export interface YoutubeCacheDoc {
  _id: string;
  videos: YtVideo[];
  nextPageToken: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface MigrationDoc {
  _id: string;
  appliedAt: Date;
}

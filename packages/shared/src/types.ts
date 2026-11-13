import type {
  AdminRole,
  AgencyAuditAction,
  AgencyRole,
  AnimationFormat,
  BadgeBlendMode,
  CosmeticType,
  Currency,
  GameLockReason,
  GameTxKind,
  GameTxStatus,
  LedgerReason,
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
} from './constants.js';

/** ISO-8601 string on the wire. */
export type IsoDate = string;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export interface LevelProgress {
  level: number;
  points: number;
  currentLevelPoints: number;
  nextLevelPoints: number | null;
  isMaxLevel: boolean;
}

export interface PublicUser {
  id: string;
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  gender: 'male' | 'female' | 'other' | null;
  country: string | null;
  level: number;
  vipTier: number;
  /** The worn tier package's badge (bottom-right of the avatar); null without an active tier. */
  badge: TierBadge | null;
  /** Equipped avatar frame (the ring); null when none. */
  frameUrl: string | null;
  frameFormat: AnimationFormat;
  followers: number;
  following: number;
  isLive: boolean;
  liveRoomId: string | null;
  agencyId: string | null;
  createdAt: IsoDate;
  /**
   * Current diamond balance. Sent by the profile endpoint (`GET /users/:uid`) only, not by
   * lists. Clients show one star per `app.diamondsPerStar` diamonds.
   */
  diamonds?: number;
}

/** Compact identity used in live rooms, chat rows, leaderboards and lists. */
export interface UserBrief {
  id: string;
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  vipTier: number;
  /** The worn tier package's badge; null without an active tier. */
  badge: TierBadge | null;
  country: string | null;
  frameUrl: string | null;
  /** How `frameUrl` plays: `none` is a still or GIF/WebP image. */
  frameFormat: AnimationFormat;
}

/**
 * Artwork of a tier package, drawn as a badge at the bottom-right of the avatar. Up to three
 * renditions of the same picture; clients play MP4, else SVGA, else the image.
 */
export interface TierBadge {
  imageUrl: string | null;
  svgaUrl: string | null;
  mp4Url: string | null;
  blendMode: BadgeBlendMode;
}

/** A tier package as the shop lists it. */
export interface TierPackage {
  id: string;
  /** 1 VIP, 2 VVIP, 3 Crown, 4 King (`VIP_TIERS`). Never changes after creation. */
  tier: number;
  name: string;
  priceDiamonds: number;
  durationDays: number;
  badge: TierBadge;
  active: boolean;
  sortOrder: number;
}

/** A tier package as the admin catalog lists it. */
export interface AdminTierPackage extends TierPackage {
  /** Users holding it now (unexpired rows). */
  ownerCount: number;
  createdAt: IsoDate;
}

/** One package in a user's inventory. */
export interface OwnedTierPackage {
  package: TierPackage;
  acquiredAt: IsoDate;
  expiresAt: IsoDate;
  expired: boolean;
  /** The one the user is wearing now. */
  worn: boolean;
  source: 'purchase' | 'admin';
  /** The admin uid behind the latest admin grant. */
  grantedBy: string | null;
}

/** Full-screen entrance effect played when someone joins a live room. */
export interface EntryEffect {
  url: string;
  format: AnimationFormat;
}

/** One agent → user transfer, as shown in the agent's history. */
export interface AgentRechargeRow {
  id: string;
  user: UserBrief | null;
  diamonds: number;
  createdAt: IsoDate;
}

/** Diamonds added to an agent's own stock by the platform, as shown in the agent's history. */
export interface AgentStockTopupRow {
  id: string;
  diamonds: number;
  /** The agent's stock right after this top-up. */
  stockAfter: number;
  createdAt: IsoDate;
}

export interface AgentRechargeSummary {
  count: number;
  totalDiamonds: number;
  todayDiamonds: number;
  monthDiamonds: number;
}

export interface MeUser extends PublicUser {
  email: string | null;
  phone: string | null;
  status: UserStatus;
  isAgent: boolean;
  adminRole: AdminRole | null;
  wallet: { diamonds: number; agentStock: number };
  levelProgress: LevelProgress;
  vipExpiresAt: IsoDate | null;
  /** On the admin's maintenance list: may use the app while maintenance mode is on. */
  maintenanceAccess: boolean;
  /** What this user may moderate from inside the app; null for everyone else. */
  moderation: MeModeration | null;
}

/**
 * In-app moderation rights. A platform moderator is an app user an admin trusted with them
 * (no dashboard access); dashboard staff with `live.moderate` share the live-room powers.
 */
export interface MeModeration {
  /** Holds the platform moderator flag: opens the Moderation panel. */
  isPlatformModerator: boolean;
  /** May remove, ban, mute and delete chat in any live room, and end any live. */
  canModerateLive: boolean;
  /** Platform moderators join lives hidden (no viewer count, join line or entrance). */
  stealthEnabled: boolean;
  /** Platform moderators may take a seat without the host's approval. */
  selfStageEnabled: boolean;
}

/** A row of the in-app Moderation panel. Never carries contact details or device ids. */
export interface ModeratedUser {
  user: UserBrief;
  status: UserStatus;
  ban: { reason: string; until: IsoDate | null; at: IsoDate } | null;
  isPlatformModerator: boolean;
  isAgent: boolean;
  /** Dashboard staff: platform moderators can't act on them. */
  isStaff: boolean;
  createdAt: IsoDate;
}

/** A device an account signed in from, as a platform moderator sees it. */
export interface ModeratedDevice {
  deviceId: string;
  platform: string | null;
  lastSeenAt: IsoDate;
  /** Accounts that have signed in on it. */
  accountCount: number;
  banned: boolean;
  /** The moderator's own handset: it can't be banned from here. */
  isYours: boolean;
}

/** What a device ban would do, before it is confirmed. Writes nothing. */
export interface DeviceBanPreview {
  devices: number;
  /** Accounts that would be banned (already-banned ones are not counted). */
  accounts: number;
  alreadyBanned: number;
  skipped: { user: UserBrief | null; uid: string; reason: string }[];
}

export interface DeviceBanResult {
  devicesBanned: number;
  accountsBanned: number;
  skipped: { uid: string; reason: string }[];
}

/** A host who banned this user from their lives. */
export interface ModeratedRoomBan {
  host: UserBrief | null;
  hostId: string;
  until: IsoDate | null;
  by: string;
  createdAt: IsoDate;
}

export interface LiveRoom {
  id: string;
  type: RoomType;
  status: RoomStatus;
  title: string;
  coverUrl: string | null;
  tags: string[];
  host: Pick<
    PublicUser,
    | 'id'
    | 'shortId'
    | 'displayName'
    | 'avatarUrl'
    | 'level'
    | 'vipTier'
    | 'badge'
    | 'country'
    | 'frameUrl'
    | 'frameFormat'
  >;
  viewerCount: number;
  peakViewers: number;
  giftDiamonds: number;
  pkBattleId: string | null;
  /** Locked rooms admit no new viewers, except with the password when one is set. */
  locked: boolean;
  hasPassword: boolean;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
}

/** Who queued a YouTube song. */
export interface YtAddedBy {
  uid: string;
  displayName: string;
}

/** One song in a live's YouTube queue. `qid` names the entry: a video can be queued again. */
export interface YtItem {
  qid: string;
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  addedBy: YtAddedBy;
}

/** The song playing now. `positionMs` was true at `updatedAt` (server clock, ms). */
export interface YtNowPlaying extends YtItem {
  playing: boolean;
  positionMs: number;
  updatedAt: number;
}

/** What a live plays from YouTube. Clients keep the snapshot with the highest `rev`. */
export interface YouTubeState {
  current: YtNowPlaying | null;
  queue: YtItem[];
  rev: number;
}

/** A YouTube search result. `reason` says why an unplayable one can't play. */
export interface YtSearchResult {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  playable: boolean;
  reason: string | null;
}

export interface Gift {
  id: string;
  name: string;
  price: number;
  iconUrl: string;
  animationUrl: string | null;
  animationFormat: AnimationFormat;
  category: string;
  sortOrder: number;
  active: boolean;
  vipTierRequired: number;
}

export interface LedgerEntry {
  id: string;
  userId: string;
  currency: Currency;
  delta: number;
  balanceAfter: number;
  reason: LedgerReason;
  refId: string | null;
  createdAt: IsoDate;
}

export interface PkBattle {
  id: string;
  status: PkStatus;
  hosts: {
    uid: string;
    roomId: string;
    /** Total across all rounds. */
    score: number;
    /** Score in the current (or last) round. */
    roundScore: number;
    roundsWon: number;
    displayName: string;
    avatarUrl: string | null;
    level: number;
    vipTier: number;
    badge: TierBadge | null;
    frameUrl: string | null;
    frameFormat: AnimationFormat;
  }[];
  invitedBy: string;
  /** Length of each round. */
  durationSec: number;
  round: number;
  maxRounds: number;
  roundState: PkRoundState | null;
  /** Gifts count from this instant (after the lead-in countdown). */
  scoringOpensAt: IsoDate | null;
  /** End of the current round. */
  endsAt: IsoDate | null;
  /** While paused: when the battle ends if no host starts the next round. */
  pausedUntil: IsoDate | null;
  rounds: { round: number; scores: [number, number]; winnerUid: string | null }[];
  inviteExpiresAt: IsoDate | null;
  startedAt: IsoDate | null;
  endedAt: IsoDate | null;
  winnerUid: string | null;
  isDraw: boolean;
  endReason: PkEndReason | null;
  /** Server time when this snapshot was produced, for client clock-offset correction. */
  serverTime: IsoDate;
}

/** Why a game can't be opened right now; null when it can. */
export interface GameLock {
  reason: GameLockReason;
  /** The level needed, when `reason` is `level`. */
  minLevel?: number;
}

/** One AsadSoft game as the app lists it (`GET /v1/games`). */
export interface GameListItem {
  gameId: string;
  name: string;
  iconUrl: string | null;
  category: string;
  lock: GameLock | null;
}

/** `POST /v1/games/:gameId/launch`: the provider URL to open, with its session token. */
export interface GameLaunch {
  gameUrl: string;
  sessionId: string;
  expiresAt: IsoDate;
}

/** A catalogue row in the admin: the provider's fields plus our local controls. */
export interface AdminGame {
  gameId: string;
  /** What the app shows: `displayName`, else the provider's name. */
  name: string;
  displayName: string | null;
  iconUrl: string | null;
  provider: {
    name: string;
    category: string;
    available: boolean;
    syncedAt: IsoDate | null;
  };
  enabled: boolean;
  liveRoom: boolean;
  /** Null: the global `games.minLevel` applies. */
  minLevel: number | null;
  sortOrder: number;
  updatedAt: IsoDate | null;
}

/** Money figures for a period. Amounts are diamonds; positive `ggr` is the platform's win. */
export interface GameMoney {
  /** Stakes minus stakes refunded or cancelled. */
  turnover: number;
  /** Wins minus wins clawed back. */
  payouts: number;
  /** Loss cashback and wager rebates paid. */
  cashback: number;
  /** turnover − payouts − cashback. */
  ggr: number;
  /** (payouts + cashback) ÷ turnover, or null with no turnover. */
  rtp: number | null;
  stakeCount: number;
  winCount: number;
  refunds: number;
  reversals: number;
  /** Transfer wallet: diamonds moved into game wallets, and back out. */
  transfersIn: number;
  transfersOut: number;
  /** Every diamond debited minus every diamond credited: what actually left players' wallets. */
  netFlow: number;
}

export interface GameStatsPeriod extends GameMoney {
  from: IsoDate;
  to: IsoDate;
  /** Distinct players with any wallet movement in the period. */
  players: number;
}

export interface GameStatsOverview {
  timezone: string;
  today: GameStatsPeriod;
  yesterday: GameStatsPeriod;
  last7Days: GameStatsPeriod;
  last30Days: GameStatsPeriod;
  allTime: GameMoney;
  /** Present when `from`/`to` were asked for. */
  range: GameStatsPeriod | null;
}

export interface GameStatsDay extends GameMoney {
  /** YYYY-MM-DD in the report timezone. */
  day: string;
  players: number;
}

export interface GameStatsByGame extends GameMoney {
  gameId: string;
  name: string;
}

export interface GameTopPlayer {
  user: UserBrief | null;
  uid: string;
  /** Positive: the player is up (the platform lost this much to them). */
  playerNet: number;
  turnover: number;
  payouts: number;
  cashback: number;
}

export interface GameTransaction {
  txId: string;
  type: 'debit' | 'credit';
  kind: GameTxKind;
  status: GameTxStatus;
  uid: string;
  user: UserBrief | null;
  gameId: string | null;
  roundId: string | null;
  gameRoundId: string | null;
  sessionId: string | null;
  refTxId: string | null;
  /** Set on a reversed row: the txId that reversed it. */
  reversedBy: string | null;
  requested: number;
  applied: number;
  /** Claw-backs: the part the player no longer held. */
  shortfall: number;
  balanceAfter: number | null;
  /** Refusal code (INSUFFICIENT_BALANCE, PLAYER_RESTRICTED, …) and the HTTP status sent. */
  code: string | null;
  httpStatus: number;
  description: string | null;
  currency: string | null;
  createdAt: IsoDate;
}

export interface GamesBlock {
  at: IsoDate;
  by: string;
  reason: string;
}

export interface GamePlayerSummary {
  uid: string;
  user: UserBrief | null;
  block: GamesBlock | null;
  lifetime: GameMoney & {
    playerNet: number;
    firstPlayedAt: IsoDate | null;
    lastPlayedAt: IsoDate | null;
    lastGameId: string | null;
  };
  today: GameMoney & { playerNet: number };
}

export interface GamesIntegrationStatus {
  configured: boolean;
  apiUrl: string | null;
  /** Paste into AsadSoft → Operators → Wallet callback URL. */
  walletCallbackUrl: string;
  lastSyncAt: IsoDate | null;
  lastCallbackAt: IsoDate | null;
  catalogSize: number;
  enabledCount: number;
}

export interface Cosmetic {
  id: string;
  type: CosmeticType;
  name: string;
  assetUrl: string;
  previewUrl: string | null;
  animationFormat: AnimationFormat;
  priceDiamonds: number;
  durationDays: number;
  vipTierRequired: number;
  /** Holders of `vipTierRequired` or higher may wear it free, without buying it. */
  vipIncluded: boolean;
  active: boolean;
  sortOrder: number;
}

/**
 * A decoration a user may wear: one they own (`source: 'owned'`, until `expiresAt`) or one
 * their tier includes (`source: 'vip'`, until the worn tier package's expiry).
 */
/** A store item with the caller's own state, as `GET /store/items` lists it. */
export interface StoreCosmetic extends Cosmetic {
  /** The caller holds it now (bought or granted, unexpired). */
  owned: boolean;
  ownedUntil: IsoDate | null;
  /** The caller is wearing it. */
  equipped: boolean;
}

export interface OwnedCosmetic {
  item: Cosmetic;
  expiresAt: IsoDate | null;
  equipped: boolean;
  source: 'owned' | 'vip';
}

/** A decoration as the admin catalog lists it. */
export interface AdminCosmetic extends Cosmetic {
  /** Users holding it now (unexpired ownership). */
  ownerCount: number;
  createdAt: IsoDate;
}

/** A row of the admin's view of one user's decorations. */
export interface AdminUserCosmetic extends OwnedCosmetic {
  acquiredAt: IsoDate | null;
  /** How the user got it; null for VIP entitlements and rows older than this field. */
  grantSource: 'purchase' | 'admin' | null;
  /** The admin uid behind the latest admin grant. */
  grantedBy: string | null;
}

export interface Report {
  id: string;
  reporterId: string;
  targetType: ReportTarget;
  targetId: string;
  reason: string;
  details: string;
  status: ReportStatus;
  createdAt: IsoDate;
}

export interface Withdrawal {
  id: string;
  userId: string;
  diamonds: number;
  amountUsd: number;
  method: string;
  status: WithdrawalStatus;
  note: string | null;
  createdAt: IsoDate;
  reviewedAt: IsoDate | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  text: string | null;
  mediaUrl: string | null;
  createdAt: IsoDate;
}

/** Object storage (Cloudflare R2) settings as the admin dashboard sees them. The secret is never sent. */
export interface StorageSettingsView {
  /** `database` = set from the dashboard, `env` = `S3_*` variables, `none` = uploads disabled. */
  source: 'database' | 'env' | 'none';
  accountId: string;
  bucket: string;
  accessKeyId: string;
  publicBaseUrl: string;
  secretSet: boolean;
  /** Last 4 characters of the secret, masked (`••••abcd`). */
  secretHint: string | null;
  updatedAt: IsoDate | null;
}

export interface StorageSettingsInput {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  /** Omit to keep the stored secret. */
  secretAccessKey?: string;
  publicBaseUrl: string;
}

// ── Host agencies ───────────────────────────────────────────────────────────

export interface AgencySummary {
  id: string;
  code: string;
  name: string;
  logoUrl: string | null;
  memberCount: number;
}

/** A row of the home-screen "Top agencies" slider. */
export interface TopAgency extends AgencySummary {
  rank: number;
  /** Diamonds the agency's hosts earned this month (agency timezone). */
  periodDiamonds: number;
}

export interface AgencyMember {
  user: UserBrief | null;
  role: AgencyRole;
  locked: boolean;
  dailyTargetMinutes: number | null;
  joinedAt: IsoDate;
  periodDiamonds: number;
  periodLiveSeconds: number;
  lifetimeDiamonds: number;
  lifetimeLiveSeconds: number;
  todayDiamonds: number;
  /** Includes the session in progress when the host is live right now. */
  todayLiveSeconds: number;
  isLive: boolean;
}

export interface AgencyDashboard {
  agency: AgencySummary & {
    ownerId: string;
    commissionRate: number;
    status: 'active' | 'suspended';
    createdAt: IsoDate;
  };
  /** The caller's role: the owner, or an agency admin. */
  role: 'owner' | 'admin';
  /** Position in this month's agency ranking, 1-based; null while suspended. */
  rank: number | null;
  periodKey: string;
  totals: {
    members: number;
    periodDiamonds: number;
    periodLiveSeconds: number;
    periodCommission: number;
    periodGifts: number;
    lifetimeDiamonds: number;
    lifetimeCommission: number;
    todayDiamonds: number;
    todayLiveSeconds: number;
    liveNow: number;
  };
  pendingRequests: number;
  pendingInvitations: number;
}

export interface AgencyDay {
  dayKey: string;
  diamonds: number;
  gifts: number;
  commission: number;
  liveSeconds: number;
  /** Hosts that went live or earned that day (agency view only). */
  activeHosts?: number;
}

export interface AgencyAnalytics {
  days: number;
  totals: { diamonds: number; gifts: number; commission: number; liveSeconds: number };
  /** Oldest first, one entry per day (zero-filled). */
  daily: AgencyDay[];
}

export interface AgencyHostAnalytics extends AgencyAnalytics {
  member: AgencyMember;
  sessions: number;
}

export interface AgencyGiftRow {
  id: string;
  sender: UserBrief | null;
  giftName: string;
  quantity: number;
  /** Diamond value of the gift for this host. */
  cost: number;
  /** What the host was credited: cost minus the platform and agency fees. */
  diamonds: number;
  commission: number;
  createdAt: IsoDate;
}

export interface AgencySessionRow {
  id: string;
  type: RoomType;
  title: string;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
  durationSec: number;
  giftDiamonds: number;
  peakViewers: number;
}

export interface AgencyLeaderboard {
  periodKey: string;
  /** Months that can be selected, newest first (the current one included). */
  periods: string[];
  items: { rank: number; user: UserBrief | null; diamonds: number; liveSeconds: number }[];
}

export interface AgencyInvitation {
  id: string;
  agency: AgencySummary;
  user: UserBrief | null;
  invitedBy: UserBrief | null;
  createdAt: IsoDate;
  expiresAt: IsoDate;
}

export interface AgencyAuditRow {
  id: string;
  action: AgencyAuditAction;
  actor: UserBrief | null;
  target: UserBrief | null;
  meta: Record<string, unknown>;
  createdAt: IsoDate;
}

export interface AgencyMembership {
  agency: AgencySummary;
  role: AgencyRole;
  locked: boolean;
  joinedAt: IsoDate;
}

// ── Live history & post-live summary ───────────────────────────────────────────

export type LiveEndReason =
  | 'host'
  | 'admin'
  | 'stale'
  | 'webhook'
  | 'banned'
  | 'moderation'
  /** Ended by a platform moderator from the app. */
  | 'moderator';

/** One ended live in a host's broadcasting history. */
export interface LiveHistoryItem {
  id: string;
  type: RoomType;
  title: string;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
  durationSec: number;
  peakViewers: number;
  /** Diamonds the host earned (after fees). */
  giftDiamonds: number;
  endReason: LiveEndReason | null;
}

/** The lives that started on one local day. */
export interface LiveHistoryDay {
  /** `YYYY-MM-DD` in the requested offset. */
  date: string;
  totalSeconds: number;
  sessionCount: number;
  peakViewers: number;
  diamonds: number;
  /** Newest first. */
  sessions: LiveHistoryItem[];
}

/** `GET /users/:uid/live-history/monthly`: one month, grouped by the day each live started. */
export interface LiveHistoryMonth {
  /** `YYYY-MM` */
  month: string;
  totalSeconds: number;
  sessionCount: number;
  liveDays: number;
  diamonds: number;
  /** The month of the host's first ended live (`YYYY-MM`), or null without any. */
  earliestMonth: string | null;
  /** Newest first. */
  days: LiveHistoryDay[];
}

/** `GET /live/:id/summary`: how one ended live went. */
export interface LiveSummary {
  roomId: string;
  type: RoomType;
  title: string;
  coverUrl: string | null;
  startedAt: IsoDate;
  endedAt: IsoDate;
  endReason: LiveEndReason | null;
  durationSec: number;
  /** False during the settle window after the end: late gifts may still be counted. */
  final: boolean;
  audience: {
    peakViewers: number;
    /** Null for lives that ended before the counter existed. */
    totalJoins: number | null;
    uniqueViewers: number | null;
    newFollowers: number;
  };
  engagement: { chatMessages: number | null; reactions: number | null };
  gifts: {
    /** Cost of the gifts the host received. */
    hostDiamonds: number;
    /** Diamonds credited to the host for them (after fees). */
    hostEarnings: number;
    /** Every gift in the room (host and guests), at cost. */
    roomDiamonds: number;
    giftCount: number;
    gifters: number;
    topGifters: { rank: number; user: UserBrief | null; diamonds: number; gifts: number }[];
    topGifts: {
      gift: { id: string; name: string; iconUrl: string | null };
      count: number;
      diamonds: number;
    }[];
  };
}

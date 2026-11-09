import type {
  AdminRole,
  AgencyAuditAction,
  AgencyRole,
  AnimationFormat,
  CosmeticType,
  Currency,
  GameKey,
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
  /** Resolved avatar frame: an equipped store frame, else the active VIP tier's frame. */
  frameUrl: string | null;
  frameFormat: AnimationFormat;
  followers: number;
  following: number;
  isLive: boolean;
  liveRoomId: string | null;
  agencyId: string | null;
  createdAt: IsoDate;
}

/** Compact identity used in live rooms, chat rows, leaderboards and lists. */
export interface UserBrief {
  id: string;
  shortId: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  vipTier: number;
  country: string | null;
  frameUrl: string | null;
  /** How `frameUrl` plays: `none` is a still or GIF/WebP image. */
  frameFormat: AnimationFormat;
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

export interface GameRound {
  id: string;
  game: GameKey;
  roundNo: number;
  status: 'betting' | 'locked' | 'settled';
  serverSeedHash: string;
  serverSeed: string | null;
  options: string[];
  totals: Record<string, number>;
  outcome: string | null;
  /** Game-specific reveal (e.g. dealt cards); null while betting is open. */
  reveal: Record<string, unknown> | null;
  bettingStartedAt: IsoDate;
  bettingEndsAt: IsoDate;
  settlesAt: IsoDate;
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
 * their VIP tier includes (`source: 'vip'`, until the membership's expiry).
 */
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

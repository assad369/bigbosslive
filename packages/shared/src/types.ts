import type {
  AdminRole,
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
  frameUrl: string | null;
  followers: number;
  following: number;
  isLive: boolean;
  liveRoomId: string | null;
  agencyId: string | null;
  createdAt: IsoDate;
}

export interface MeUser extends PublicUser {
  email: string | null;
  phone: string | null;
  status: UserStatus;
  isAgent: boolean;
  adminRole: AdminRole | null;
  wallet: { diamonds: number; beans: number; agentStock: number };
  levelProgress: LevelProgress;
  vipExpiresAt: IsoDate | null;
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
    'id' | 'shortId' | 'displayName' | 'avatarUrl' | 'level' | 'vipTier' | 'country'
  >;
  viewerCount: number;
  peakViewers: number;
  giftBeans: number;
  pkBattleId: string | null;
  /** Locked rooms admit no new viewers, except with the password when one is set. */
  locked: boolean;
  hasPassword: boolean;
  startedAt: IsoDate;
  endedAt: IsoDate | null;
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
  active: boolean;
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
  beans: number;
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

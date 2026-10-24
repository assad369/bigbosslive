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
    score: number;
    displayName: string;
    avatarUrl: string | null;
  }[];
  durationSec: number;
  startedAt: IsoDate | null;
  endsAt: IsoDate | null;
  winnerUid: string | null;
  isDraw: boolean;
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

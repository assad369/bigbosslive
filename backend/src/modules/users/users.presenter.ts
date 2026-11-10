import type {
  AnimationFormat,
  LevelProgress,
  MeUser,
  PublicUser,
  TierBadge,
  UserBrief as UserBriefWire,
} from '@bigboss/shared';
import type { UserDoc } from '../../db/schema.js';

export const PUBLIC_USER_PROJECTION = {
  shortId: 1,
  displayName: 1,
  avatarUrl: 1,
  bio: 1,
  gender: 1,
  country: 1,
  level: 1,
  vip: 1,
  equipped: 1,
  stats: 1,
  liveRoomId: 1,
  agencyId: 1,
  createdAt: 1,
  status: 1,
} as const;

export type PublicUserSource = Pick<
  UserDoc,
  | '_id'
  | 'shortId'
  | 'displayName'
  | 'avatarUrl'
  | 'bio'
  | 'gender'
  | 'country'
  | 'level'
  | 'vip'
  | 'equipped'
  | 'stats'
  | 'liveRoomId'
  | 'agencyId'
  | 'createdAt'
>;

/**
 * The tier of the worn tier package, only while unexpired: an expired slot reads as none
 * before the hourly sweep clears it.
 */
export function activeVipTier(vip: UserDoc['vip'], now = new Date()): number {
  return vip.tier > 0 && (!vip.expiresAt || vip.expiresAt > now) ? vip.tier : 0;
}

/** The worn tier package's badge while its tier is active, else null. */
export function activeBadge(vip: UserDoc['vip'], now = new Date()): TierBadge | null {
  if (!activeVipTier(vip, now) || !vip.badge) return null;
  const b = vip.badge;
  return {
    imageUrl: b.imageUrl ?? null,
    svgaUrl: b.svgaUrl ?? null,
    mp4Url: b.mp4Url ?? null,
    blendMode: b.blendMode ?? 'normal',
  };
}

/**
 * The avatar frame a user shows: the equipped store frame (one worn through a tier only while
 * that tier is still held). Tiers carry no frame of their own; their artwork is the badge.
 */
export function resolveFrame(
  u: { vip: UserDoc['vip']; equipped?: UserDoc['equipped'] },
  now = new Date(),
): { frameUrl: string | null; frameFormat: AnimationFormat } {
  const e = u.equipped;
  if (e?.frameUrl && (e.frameVipTier ?? 0) <= activeVipTier(u.vip, now))
    return { frameUrl: e.frameUrl, frameFormat: e.frameFormat ?? 'none' };
  return { frameUrl: null, frameFormat: 'none' };
}

export function toPublicUser(u: PublicUserSource, now = new Date()): PublicUser {
  return {
    id: u._id,
    shortId: u.shortId,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    bio: u.bio,
    gender: u.gender,
    country: u.country,
    level: u.level.level,
    vipTier: activeVipTier(u.vip, now),
    badge: activeBadge(u.vip, now),
    ...resolveFrame(u, now),
    followers: u.stats.followers,
    following: u.stats.following,
    isLive: Boolean(u.liveRoomId),
    liveRoomId: u.liveRoomId ? String(u.liveRoomId) : null,
    agencyId: u.agencyId ? String(u.agencyId) : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toMeUser(
  u: UserDoc,
  levelProgress: LevelProgress,
  now = new Date(),
  maintenanceAccess = false,
): MeUser {
  return {
    ...toPublicUser(u, now),
    email: u.email,
    phone: u.phone,
    status: u.status,
    isAgent: u.isAgent,
    adminRole: u.adminRole,
    wallet: { ...u.wallet },
    levelProgress,
    vipExpiresAt: activeVipTier(u.vip, now) ? (u.vip.expiresAt?.toISOString() ?? null) : null,
    maintenanceAccess,
  };
}

/** Compact identity used in live rooms, chat rows, leaderboards. */
export function toUserBrief(
  u: Pick<UserDoc, '_id' | 'shortId' | 'displayName' | 'avatarUrl' | 'level' | 'vip' | 'country'> &
    Partial<Pick<UserDoc, 'equipped'>>,
  now = new Date(),
): UserBriefWire {
  return {
    id: u._id,
    shortId: u.shortId,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    level: u.level.level,
    vipTier: activeVipTier(u.vip, now),
    badge: activeBadge(u.vip, now),
    country: u.country,
    ...resolveFrame(u, now),
  };
}
export type UserBrief = UserBriefWire;

export const BRIEF_PROJECTION = {
  shortId: 1,
  displayName: 1,
  avatarUrl: 1,
  level: 1,
  vip: 1,
  country: 1,
  equipped: 1,
} as const;

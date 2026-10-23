import type { LevelProgress, MeUser, PublicUser } from '@bigboss/shared';
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

/** VIP tier only counts while unexpired; the stored tier is not cleared by a job. */
export function activeVipTier(vip: UserDoc['vip'], now = new Date()): number {
  return vip.tier > 0 && (!vip.expiresAt || vip.expiresAt > now) ? vip.tier : 0;
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
    frameUrl: u.equipped.frameUrl,
    followers: u.stats.followers,
    following: u.stats.following,
    isLive: Boolean(u.liveRoomId),
    liveRoomId: u.liveRoomId ? String(u.liveRoomId) : null,
    agencyId: u.agencyId ? String(u.agencyId) : null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function toMeUser(u: UserDoc, levelProgress: LevelProgress, now = new Date()): MeUser {
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
  };
}

/** Compact identity used in live rooms, chat rows, leaderboards. */
export function toUserBrief(u: Pick<UserDoc, '_id' | 'shortId' | 'displayName' | 'avatarUrl' | 'level' | 'vip' | 'country'> & Partial<Pick<UserDoc, 'equipped'>>, now = new Date()) {
  return {
    id: u._id,
    shortId: u.shortId,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    level: u.level.level,
    vipTier: activeVipTier(u.vip, now),
    country: u.country,
    frameUrl: u.equipped?.frameUrl ?? null,
  };
}
export type UserBrief = ReturnType<typeof toUserBrief>;

export const BRIEF_PROJECTION = {
  shortId: 1,
  displayName: 1,
  avatarUrl: 1,
  level: 1,
  vip: 1,
  country: 1,
  equipped: 1,
} as const;

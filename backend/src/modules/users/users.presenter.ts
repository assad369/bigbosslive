import type {
  AnimationFormat,
  LevelProgress,
  MeUser,
  PublicUser,
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

/** VIP tier only counts while unexpired; the stored tier is not cleared by a job. */
export function activeVipTier(vip: UserDoc['vip'], now = new Date()): number {
  return vip.tier > 0 && (!vip.expiresAt || vip.expiresAt > now) ? vip.tier : 0;
}

/**
 * The avatar frame a user shows: an equipped store frame wins, otherwise the frame of the VIP
 * tier they hold while it is active. An expired VIP drops its frame without any job running.
 */
export function resolveFrame(
  u: { vip: UserDoc['vip']; equipped?: UserDoc['equipped'] },
  now = new Date(),
): { frameUrl: string | null; frameFormat: AnimationFormat } {
  const e = u.equipped;
  if (e?.frameUrl) return { frameUrl: e.frameUrl, frameFormat: e.frameFormat ?? 'none' };
  if (e?.vipFrameUrl && activeVipTier(u.vip, now) > 0)
    return { frameUrl: e.vipFrameUrl, frameFormat: e.vipFrameFormat ?? 'none' };
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
    ...resolveFrame(u, now),
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

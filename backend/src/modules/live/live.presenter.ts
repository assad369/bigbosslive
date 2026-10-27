import type { LiveRoom } from '@bigboss/shared';
import type { LiveRoomDoc } from '../../db/schema.js';
import type { UserBrief } from '../users/users.presenter.js';

export function toLiveRoom(r: LiveRoomDoc, host: UserBrief | undefined): LiveRoom {
  return {
    id: String(r._id),
    type: r.type,
    status: r.status,
    title: r.title,
    coverUrl: r.coverUrl ?? host?.avatarUrl ?? null,
    tags: r.tags,
    host: {
      id: r.hostId,
      shortId: host?.shortId ?? '',
      displayName: host?.displayName ?? 'Host',
      avatarUrl: host?.avatarUrl ?? null,
      level: host?.level ?? 0,
      vipTier: host?.vipTier ?? 0,
      country: host?.country ?? null,
    },
    viewerCount: r.viewerCount,
    peakViewers: r.peakViewers,
    giftBeans: r.giftBeans,
    pkBattleId: r.pkBattleId ? String(r.pkBattleId) : null,
    locked: Boolean(r.locked),
    hasPassword: Boolean(r.locked && r.passwordHash),
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}

export function toRoomDetail(
  r: LiveRoomDoc,
  host: UserBrief | undefined,
  users: Map<string, UserBrief>,
) {
  return {
    ...toLiveRoom(r, host),
    livekitRoom: r.livekitRoom,
    moderatorIds: r.moderatorIds,
    moderators: r.moderatorIds.flatMap((id) => users.get(id) ?? []),
    backgroundUrl: r.backgroundUrl,
    seats: r.seats.map((s) => ({
      index: s.index,
      userId: s.userId,
      muted: s.muted,
      // Absent on rooms started before camera moderation existed.
      videoMuted: Boolean(s.videoMuted),
      locked: s.locked,
      user: s.userId ? (users.get(s.userId) ?? null) : null,
    })),
  };
}

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
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}

export function toRoomDetail(r: LiveRoomDoc, host: UserBrief | undefined, seatUsers: Map<string, UserBrief>) {
  return {
    ...toLiveRoom(r, host),
    livekitRoom: r.livekitRoom,
    moderatorIds: r.moderatorIds,
    backgroundUrl: r.backgroundUrl,
    seats: r.seats.map((s) => ({ ...s, user: s.userId ? (seatUsers.get(s.userId) ?? null) : null })),
  };
}

import { ObjectId, type Filter, type Sort } from 'mongodb';
import { z } from 'zod';
import { LIVEKIT_TOPICS, ROOM_TYPES, SOCKET, type RoomType } from '@bigboss/shared';
import type { Ctx } from '../../context.js';
import type { LiveRoomDoc, SeatDoc } from '../../db/schema.js';
import {
  AppError,
  badRequest,
  forbidden,
  isDuplicateKeyError,
  notFound,
} from '../../lib/errors.js';
import { addSeconds } from '../../lib/time.js';
import { activeVipTier } from '../users/users.presenter.js';
import { toLiveRoom, toRoomDetail } from './live.presenter.js';

export const startLiveInput = z.object({
  type: z.enum(ROOM_TYPES).default('video'),
  title: z.string().trim().min(1).max(60),
  coverUrl: z.url().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(20)).max(5).default([]),
});

export type LiveRole = 'host' | 'moderator' | 'guest' | 'audience';

const VIDEO_SEATS = 4;

/**
 * Live rooms (video and audio). Mongo holds room state; LiveKit carries media and the data
 * channel. LiveKit identity == user uid. Every token is minted here with server-authoritative
 * metadata (level, VIP, role), and publish permission is granted only to the host and seated
 * guests.
 */
export class LiveService {
  constructor(private readonly ctx: Ctx) {}

  async get(roomId: ObjectId): Promise<LiveRoomDoc> {
    const room = await this.ctx.col.liveRooms.findOne({ _id: roomId });
    if (!room) throw notFound('Live room');
    return room;
  }

  async getLive(roomId: ObjectId): Promise<LiveRoomDoc> {
    const room = await this.get(roomId);
    if (room.status !== 'live') throw new AppError(410, 'room_ended', 'This live has ended');
    return room;
  }

  async detail(roomId: ObjectId) {
    const room = await this.get(roomId);
    const briefs = await this.ctx.services.users.briefs([
      room.hostId,
      ...room.seats.map((s) => s.userId).filter((u): u is string => Boolean(u)),
    ]);
    return toRoomDetail(room, briefs.get(room.hostId), briefs);
  }

  private async metadataFor(uid: string, role: LiveRole) {
    const user = await this.ctx.services.users.get(uid);
    const now = this.ctx.clock.now();
    return {
      user,
      metadata: {
        uid: user._id,
        shortId: user.shortId,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        level: user.level.level,
        vipTier: activeVipTier(user.vip, now),
        frameUrl: user.equipped.frameUrl,
        role,
        isAdmin: Boolean(user.adminRole),
      },
    };
  }

  private async tokenFor(room: LiveRoomDoc, uid: string, role: LiveRole) {
    const { user, metadata } = await this.metadataFor(uid, role);
    const token = await this.ctx.livekit.createToken({
      room: room.livekitRoom,
      identity: uid,
      name: user.displayName,
      canPublish: role === 'host' || role === 'guest',
      metadata,
    });
    return { token, url: this.ctx.livekit.url, identity: uid, role, metadata };
  }

  private async resume(room: LiveRoomDoc) {
    await this.ctx.col.liveRooms.updateOne(
      { _id: room._id },
      { $set: { lastHeartbeatAt: this.ctx.clock.now() } },
    );
    return {
      room: await this.detail(room._id),
      credentials: await this.tokenFor(room, room.hostId, 'host'),
      resumed: true,
    };
  }

  /** Go live. If the host already has a live room it is resumed (app crash / reconnect). */
  async start(hostId: string, input: z.infer<typeof startLiveInput>) {
    const features = await this.ctx.services.config.get('features');
    if (input.type === 'audio' && !features.audioRoomsEnabled)
      throw forbidden('Audio rooms are disabled');
    const existing = await this.ctx.col.liveRooms.findOne({ hostId, status: 'live' });
    if (existing) return this.resume(existing);

    const title = await this.ctx.services.moderation.assertClean(input.title, 'title');
    const host = await this.ctx.services.users.get(hostId);
    const liveCfg = await this.ctx.services.config.get('live');
    const seatCount = input.type === 'audio' ? liveCfg.audioSeatCount : VIDEO_SEATS;
    const seats: SeatDoc[] = Array.from({ length: seatCount }, (_, index) => ({
      index,
      userId: index === 0 ? hostId : null,
      muted: false,
      locked: false,
    }));
    const now = this.ctx.clock.now();
    const room: LiveRoomDoc = {
      _id: new ObjectId(),
      hostId,
      type: input.type,
      status: 'live',
      title,
      coverUrl: input.coverUrl,
      tags: input.tags,
      country: host.country,
      livekitRoom: `bb_${hostId}_${now.getTime()}`,
      viewerCount: 0,
      peakViewers: 0,
      giftBeans: 0,
      giftCount: 0,
      moderatorIds: [],
      seats,
      pkBattleId: null,
      backgroundUrl: null,
      startedAt: now,
      lastHeartbeatAt: now,
      endedAt: null,
      endReason: null,
      endedBy: null,
    };
    try {
      await this.ctx.col.liveRooms.insertOne(room);
    } catch (err) {
      // Lost a race with a concurrent start: resume whichever room won.
      const winner = isDuplicateKeyError(err)
        ? await this.ctx.col.liveRooms.findOne({ hostId, status: 'live' })
        : null;
      if (winner) return this.resume(winner);
      throw err;
    }
    await this.ctx.col.users.updateOne({ _id: hostId }, { $set: { liveRoomId: room._id } });

    const detail = await this.detail(room._id);
    this.ctx.realtime.toRoom(
      SOCKET.namespaces.app,
      'rooms',
      SOCKET.app.roomUpserted,
      toLiveRoom(room, undefined),
    );
    if (liveCfg.followerPushOnGoLive) {
      await this.ctx.jobs.enqueue('push.followers', { hostId, roomId: String(room._id) });
    }
    return { room: detail, credentials: await this.tokenFor(room, hostId, 'host'), resumed: false };
  }

  /** Viewer join: checks bans/blocks, returns a subscribe-only token (publish if seated). */
  async join(roomId: ObjectId, uid: string) {
    const room = await this.getLive(roomId);
    if (room.hostId === uid)
      return {
        room: await this.detail(roomId),
        credentials: await this.tokenFor(room, uid, 'host'),
      };

    const now = this.ctx.clock.now();
    const ban = await this.ctx.col.roomBans.findOne({ hostId: room.hostId, userId: uid });
    if (ban && (!ban.until || ban.until > now)) {
      throw new AppError(403, 'room_banned', 'You were removed from this live', {
        until: ban.until,
      });
    }
    if (await this.ctx.services.users.isBlockedEitherWay(uid, room.hostId))
      throw forbidden('You cannot join this live');

    const role: LiveRole = room.seats.some((s) => s.userId === uid)
      ? 'guest'
      : room.moderatorIds.includes(uid)
        ? 'moderator'
        : 'audience';
    const credentials = await this.tokenFor(room, uid, role);

    // Entry banner (VIP / entry animation) for everyone in the room.
    const entry = await this.ctx.services.store.entryAnimationFor(uid);
    if (credentials.metadata.vipTier > 0 || entry) {
      void this.ctx.livekit
        .sendData(room.livekitRoom, LIVEKIT_TOPICS.entry, {
          user: credentials.metadata,
          animation: entry,
        })
        .catch(() => undefined);
    }
    return { room: await this.detail(roomId), credentials };
  }

  async heartbeat(roomId: ObjectId, hostId: string): Promise<void> {
    const res = await this.ctx.col.liveRooms.updateOne(
      { _id: roomId, hostId, status: 'live' },
      { $set: { lastHeartbeatAt: this.ctx.clock.now() } },
    );
    if (!res.matchedCount) throw new AppError(410, 'room_ended', 'This live has ended');
  }

  async update(
    roomId: ObjectId,
    hostId: string,
    patch: { title?: string; backgroundUrl?: string | null; coverUrl?: string | null },
  ) {
    const $set: Partial<LiveRoomDoc> = {};
    if (patch.title !== undefined)
      $set.title = await this.ctx.services.moderation.assertClean(patch.title, 'title');
    if (patch.backgroundUrl !== undefined) $set.backgroundUrl = patch.backgroundUrl;
    if (patch.coverUrl !== undefined) $set.coverUrl = patch.coverUrl;
    const res = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, hostId, status: 'live' },
      { $set },
      { returnDocument: 'after' },
    );
    if (!res) throw notFound('Your live room');
    await this.broadcastSystem(res, {
      kind: 'room_updated',
      title: res.title,
      backgroundUrl: res.backgroundUrl,
    });
    return this.detail(roomId);
  }

  /**
   * End a room. Conditional on `status: 'live'`, so concurrent enders (host, sweeper, webhook,
   * admin) are safe — exactly one wins and runs the side effects.
   */
  async end(
    roomId: ObjectId,
    reason: NonNullable<LiveRoomDoc['endReason']>,
    by: string | null,
  ): Promise<LiveRoomDoc | null> {
    const now = this.ctx.clock.now();
    const room = await this.ctx.col.liveRooms.findOneAndUpdate(
      { _id: roomId, status: 'live' },
      { $set: { status: 'ended', endedAt: now, endReason: reason, endedBy: by, viewerCount: 0 } },
      { returnDocument: 'after' },
    );
    if (!room) return null;

    const seconds = Math.max(0, Math.round((now.getTime() - room.startedAt.getTime()) / 1000));
    const host = await this.ctx.col.users.findOneAndUpdate(
      { _id: room.hostId, liveRoomId: room._id },
      { $set: { liveRoomId: null }, $inc: { 'stats.liveSeconds': seconds } },
      { returnDocument: 'after', projection: { agencyId: 1 } },
    );
    if (host?.agencyId) {
      await this.ctx.services.agencies
        .recordLiveTime(host.agencyId, room.hostId, seconds)
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'agency live time failed'));
    }
    if (room.pkBattleId) {
      await this.ctx.services.pk
        .forfeitForHost(room.pkBattleId, room.hostId)
        .catch((err: unknown) => this.ctx.log.warn({ err }, 'pk forfeit failed'));
    }
    await Promise.all([
      this.ctx.col.roomPresence.deleteMany({ roomId: room._id }),
      this.ctx.col.seatRequests.updateMany(
        { roomId: room._id, status: 'pending' },
        { $set: { status: 'cancelled' } },
      ),
    ]);
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.roomEnded, { roomId: String(room._id), reason })
      .catch(() => undefined);
    await this.ctx.livekit.deleteRoom(room.livekitRoom).catch(() => undefined);
    this.ctx.realtime.toRoom(SOCKET.namespaces.app, 'rooms', SOCKET.app.roomEnded, {
      id: String(room._id),
    });
    return room;
  }

  async endByHost(roomId: ObjectId, hostId: string) {
    const room = await this.get(roomId);
    if (room.hostId !== hostId) throw forbidden('Only the host can end this live');
    const ended = (await this.end(roomId, 'host', hostId)) ?? room;
    return {
      durationSec: Math.round(
        ((ended.endedAt ?? this.ctx.clock.now()).getTime() - ended.startedAt.getTime()) / 1000,
      ),
      peakViewers: ended.peakViewers,
      giftBeans: ended.giftBeans,
      giftCount: ended.giftCount,
    };
  }

  async endActiveRoomFor(
    uid: string,
    reason: NonNullable<LiveRoomDoc['endReason']>,
    by: string,
  ): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { hostId: uid, status: 'live' },
      { projection: { _id: 1 } },
    );
    if (room) await this.end(room._id, reason, by);
  }

  // ── Directory ───────────────────────────────────────────────────────────────

  async list(opts: {
    type?: RoomType;
    tab: 'popular' | 'new' | 'following' | 'nearby';
    viewerUid: string;
    country?: string | null;
    page: number;
    pageSize: number;
  }) {
    const q: Filter<LiveRoomDoc> = { status: 'live' };
    if (opts.type) q.type = opts.type;
    if (opts.tab === 'nearby' && opts.country) q.country = opts.country;
    if (opts.tab === 'following') {
      const following = await this.ctx.col.follows
        .find({ followerId: opts.viewerUid }, { projection: { followeeId: 1 } })
        .limit(2000)
        .toArray();
      q.hostId = { $in: following.map((f) => f.followeeId) };
    }
    const blocked = await this.ctx.col.blocks
      .find({ $or: [{ blockerId: opts.viewerUid }, { blockedId: opts.viewerUid }] })
      .limit(1000)
      .toArray();
    if (blocked.length) {
      const hidden = blocked.map((b) =>
        b.blockerId === opts.viewerUid ? b.blockedId : b.blockerId,
      );
      q.hostId = q.hostId
        ? { $in: (q.hostId as { $in: string[] }).$in.filter((h) => !hidden.includes(h)) }
        : { $nin: hidden };
    }
    const sort: Sort = opts.tab === 'new' ? { startedAt: -1 } : { viewerCount: -1, startedAt: -1 };
    const [rooms, total] = await Promise.all([
      this.ctx.col.liveRooms
        .find(q)
        .sort(sort)
        .skip((opts.page - 1) * opts.pageSize)
        .limit(opts.pageSize)
        .toArray(),
      this.ctx.col.liveRooms.countDocuments(q),
    ]);
    const briefs = await this.ctx.services.users.briefs(rooms.map((r) => r.hostId));
    return {
      items: rooms.map((r) => toLiveRoom(r, briefs.get(r.hostId))),
      total,
      page: opts.page,
      pageSize: opts.pageSize,
    };
  }

  async viewers(roomId: ObjectId, limit = 100) {
    const rows = await this.ctx.col.roomPresence
      .find({ roomId })
      .sort({ joinedAt: 1 })
      .limit(limit)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.identity));
    return [...briefs.values()].sort((a, b) => b.vipTier - a.vipTier || b.level - a.level);
  }

  async history(hostId: string, page: number, pageSize: number) {
    const q: Filter<LiveRoomDoc> = { hostId, status: 'ended' };
    const [rooms, total, totals] = await Promise.all([
      this.ctx.col.liveRooms
        .find(q)
        .sort({ startedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      this.ctx.col.liveRooms.countDocuments(q),
      this.ctx.col.liveRooms
        .aggregate<{ seconds: number; beans: number }>([
          { $match: q },
          {
            $group: {
              _id: null,
              seconds: { $sum: { $divide: [{ $subtract: ['$endedAt', '$startedAt'] }, 1000] } },
              beans: { $sum: '$giftBeans' },
            },
          },
        ])
        .toArray(),
    ]);
    return {
      items: rooms.map((r) => ({
        id: String(r._id),
        type: r.type,
        title: r.title,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationSec: r.endedAt
          ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
          : 0,
        peakViewers: r.peakViewers,
        giftBeans: r.giftBeans,
        endReason: r.endReason,
      })),
      total,
      page,
      pageSize,
      totals: { seconds: Math.round(totals[0]?.seconds ?? 0), beans: totals[0]?.beans ?? 0 },
    };
  }

  // ── Moderation ──────────────────────────────────────────────────────────────

  private async assertCanModerate(
    room: LiveRoomDoc,
    actorUid: string,
    actorIsAdmin: boolean,
  ): Promise<void> {
    if (actorIsAdmin || room.hostId === actorUid || room.moderatorIds.includes(actorUid)) return;
    throw forbidden('Only the host or a room moderator can do that');
  }

  async kick(
    roomId: ObjectId,
    actor: { uid: string; isAdmin: boolean },
    targetUid: string,
    banMinutes: number | null,
  ): Promise<void> {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actor.uid, actor.isAdmin);
    if (targetUid === room.hostId) throw badRequest('The host cannot be removed');
    if (room.moderatorIds.includes(targetUid) && room.hostId !== actor.uid && !actor.isAdmin) {
      throw forbidden('Moderators cannot remove other moderators');
    }
    const now = this.ctx.clock.now();
    await this.ctx.col.roomBans.updateOne(
      { hostId: room.hostId, userId: targetUid },
      {
        $set: {
          until: banMinutes === null ? null : addSeconds(now, banMinutes * 60),
          by: actor.uid,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    await this.vacateSeatOf(room, targetUid);
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.kick, { uid: targetUid, by: actor.uid })
      .catch(() => undefined);
    await this.ctx.livekit.removeParticipant(room.livekitRoom, targetUid).catch(() => undefined);
  }

  async unbanFromRoom(hostId: string, targetUid: string): Promise<void> {
    await this.ctx.col.roomBans.deleteOne({ hostId, userId: targetUid });
  }

  async roomBans(hostId: string) {
    const rows = await this.ctx.col.roomBans
      .find({ hostId })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      until: r.until,
      createdAt: r.createdAt,
    }));
  }

  async setModerator(
    roomId: ObjectId,
    hostId: string,
    uid: string,
    enabled: boolean,
  ): Promise<void> {
    const res = await this.ctx.col.liveRooms.updateOne(
      { _id: roomId, hostId, status: 'live' },
      enabled ? { $addToSet: { moderatorIds: uid } } : { $pull: { moderatorIds: uid } },
    );
    if (!res.matchedCount) throw notFound('Your live room');
    const room = await this.get(roomId);
    await this.broadcastSystem(room, { kind: 'moderator', uid, enabled });
  }

  async broadcastSystem(room: LiveRoomDoc, payload: Record<string, unknown>): Promise<void> {
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.system, payload)
      .catch(() => undefined);
  }

  // ── Seats (guests in video rooms, speakers in audio rooms) ──────────────────────

  private async broadcastSeats(roomId: ObjectId): Promise<void> {
    const detail = await this.detail(roomId);
    await this.ctx.livekit
      .sendData(detail.livekitRoom, LIVEKIT_TOPICS.seats, { seats: detail.seats })
      .catch(() => undefined);
  }

  /** Atomically take a free seat. `index` null = first free seat. */
  private async occupySeat(room: LiveRoomDoc, uid: string, index: number | null): Promise<number> {
    const candidates = room.seats.filter(
      (s) => s.index > 0 && !s.userId && !s.locked && (index === null || s.index === index),
    );
    for (const seat of candidates) {
      const res = await this.ctx.col.liveRooms.updateOne(
        {
          _id: room._id,
          status: 'live',
          'seats.userId': { $ne: uid },
          seats: { $elemMatch: { index: seat.index, userId: null, locked: false } },
        },
        { $set: { 'seats.$.userId': uid, 'seats.$.muted': false } },
      );
      if (res.modifiedCount) {
        await this.ctx.livekit
          .updateParticipantPermissions(room.livekitRoom, uid, true)
          .catch(() => undefined);
        await this.broadcastSeats(room._id);
        return seat.index;
      }
    }
    throw new AppError(409, 'seat_unavailable', 'No seat available');
  }

  private async vacateSeatOf(room: LiveRoomDoc, uid: string): Promise<boolean> {
    const res = await this.ctx.col.liveRooms.updateOne(
      { _id: room._id, seats: { $elemMatch: { userId: uid, index: { $gt: 0 } } } },
      { $set: { 'seats.$.userId': null, 'seats.$.muted': false } },
    );
    if (!res.modifiedCount) return false;
    await this.ctx.livekit
      .updateParticipantPermissions(room.livekitRoom, uid, false)
      .catch(() => undefined);
    await this.broadcastSeats(room._id);
    return true;
  }

  async requestSeat(roomId: ObjectId, uid: string) {
    const room = await this.getLive(roomId);
    if (room.seats.some((s) => s.userId === uid)) throw badRequest('You are already on a seat');
    const ttl = (await this.ctx.services.config.get('live')).seatRequestTtlSec;
    const now = this.ctx.clock.now();
    await this.ctx.col.seatRequests.updateOne(
      { roomId, userId: uid, kind: 'request', status: 'pending' },
      {
        $set: { expiresAt: addSeconds(now, ttl) },
        $setOnInsert: { roomId, userId: uid, kind: 'request', status: 'pending', createdAt: now },
      },
      { upsert: true },
    );
    const { metadata } = await this.metadataFor(uid, 'audience');
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.seats, { kind: 'request', user: metadata }, [
        room.hostId,
        ...room.moderatorIds,
      ])
      .catch(() => undefined);
  }

  async seatRequests(roomId: ObjectId, hostId: string) {
    const room = await this.getLive(roomId);
    if (room.hostId !== hostId && !room.moderatorIds.includes(hostId)) throw forbidden();
    const rows = await this.ctx.col.seatRequests
      .find({
        roomId,
        kind: 'request',
        status: 'pending',
        expiresAt: { $gt: this.ctx.clock.now() },
      })
      .sort({ createdAt: 1 })
      .toArray();
    const briefs = await this.ctx.services.users.briefs(rows.map((r) => r.userId));
    return rows.map((r) => ({
      user: briefs.get(r.userId) ?? null,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  }

  /** Host/moderator accepts a pending request (or invites directly when none exists). */
  async decideSeat(
    roomId: ObjectId,
    actorUid: string,
    uid: string,
    accept: boolean,
    index: number | null,
  ) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actorUid, false);
    const now = this.ctx.clock.now();
    const req = await this.ctx.col.seatRequests.findOneAndUpdate(
      { roomId, userId: uid, kind: 'request', status: 'pending', expiresAt: { $gt: now } },
      { $set: { status: accept ? 'accepted' : 'rejected' } },
    );
    if (!req) throw notFound('Pending seat request');
    if (!accept) return { seated: false as const };
    return { seated: true as const, index: await this.occupySeat(room, uid, index) };
  }

  async inviteToSeat(roomId: ObjectId, hostUid: string, uid: string) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, hostUid, false);
    const ttl = (await this.ctx.services.config.get('live')).seatRequestTtlSec;
    const now = this.ctx.clock.now();
    await this.ctx.col.seatRequests.updateOne(
      { roomId, userId: uid, kind: 'invite', status: 'pending' },
      {
        $set: { expiresAt: addSeconds(now, ttl) },
        $setOnInsert: { roomId, userId: uid, kind: 'invite', status: 'pending', createdAt: now },
      },
      { upsert: true },
    );
    await this.ctx.livekit
      .sendData(room.livekitRoom, LIVEKIT_TOPICS.seats, { kind: 'invite', from: hostUid }, [uid])
      .catch(() => undefined);
  }

  async respondToInvite(roomId: ObjectId, uid: string, accept: boolean) {
    const room = await this.getLive(roomId);
    const req = await this.ctx.col.seatRequests.findOneAndUpdate(
      {
        roomId,
        userId: uid,
        kind: 'invite',
        status: 'pending',
        expiresAt: { $gt: this.ctx.clock.now() },
      },
      { $set: { status: accept ? 'accepted' : 'rejected' } },
    );
    if (!req) throw notFound('Pending invitation');
    if (!accept) return { seated: false as const };
    return { seated: true as const, index: await this.occupySeat(room, uid, null) };
  }

  async leaveSeat(roomId: ObjectId, uid: string): Promise<void> {
    const room = await this.getLive(roomId);
    if (!(await this.vacateSeatOf(room, uid))) throw badRequest('You are not on a seat');
  }

  async manageSeat(
    roomId: ObjectId,
    actorUid: string,
    index: number,
    action: 'remove' | 'mute' | 'unmute' | 'lock' | 'unlock',
  ) {
    const room = await this.getLive(roomId);
    await this.assertCanModerate(room, actorUid, false);
    if (index === 0 && action !== 'mute' && action !== 'unmute')
      throw badRequest('The host seat cannot be changed');
    const seat = room.seats.find((s) => s.index === index);
    if (!seat) throw notFound('Seat');
    if (action === 'remove') {
      if (seat.userId) await this.vacateSeatOf(room, seat.userId);
      return;
    }
    const $set =
      action === 'mute' || action === 'unmute'
        ? { 'seats.$.muted': action === 'mute' }
        : {
            'seats.$.locked': action === 'lock',
            ...(action === 'lock' ? { 'seats.$.userId': null } : {}),
          };
    if (action === 'lock' && seat.userId) {
      await this.ctx.livekit
        .updateParticipantPermissions(room.livekitRoom, seat.userId, false)
        .catch(() => undefined);
    }
    await this.ctx.col.liveRooms.updateOne({ _id: room._id, 'seats.index': index }, { $set });
    await this.broadcastSeats(room._id);
  }

  // ── LiveKit webhooks & sweeping ────────────────────────────────────────────────

  async onParticipantJoined(livekitRoom: string, identity: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom, status: 'live' },
      { projection: { _id: 1, hostId: 1 } },
    );
    if (!room || identity === room.hostId) return;
    await this.ctx.col.roomPresence.updateOne(
      { roomId: room._id, identity },
      { $setOnInsert: { roomId: room._id, identity, joinedAt: this.ctx.clock.now() } },
      { upsert: true },
    );
    await this.syncViewerCount(room._id);
  }

  async onParticipantLeft(livekitRoom: string, identity: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom },
      { projection: { _id: 1, hostId: 1, status: 1, seats: 1, livekitRoom: 1 } },
    );
    if (!room) return;
    await this.ctx.col.roomPresence.deleteOne({ roomId: room._id, identity });
    if (room.status === 'live') {
      if (identity !== room.hostId)
        await this.vacateSeatOf(room as LiveRoomDoc, identity).catch(() => false);
      await this.syncViewerCount(room._id);
    }
  }

  /** Viewer count is recomputed from presence rows, so webhook redelivery cannot skew it. */
  private async syncViewerCount(roomId: ObjectId): Promise<void> {
    const count = await this.ctx.col.roomPresence.countDocuments({ roomId });
    await this.ctx.col.liveRooms.updateOne({ _id: roomId, status: 'live' }, [
      { $set: { viewerCount: count, peakViewers: { $max: ['$peakViewers', count] } } },
    ]);
  }

  async onRoomFinished(livekitRoom: string): Promise<void> {
    const room = await this.ctx.col.liveRooms.findOne(
      { livekitRoom, status: 'live' },
      { projection: { _id: 1 } },
    );
    if (room) await this.end(room._id, 'webhook', null);
  }

  /** Close rooms whose host stopped heart-beating (app killed, network lost). */
  async sweepStale(): Promise<number> {
    const { staleAfterSec } = await this.ctx.services.config.get('live');
    const cutoff = addSeconds(this.ctx.clock.now(), -staleAfterSec);
    const stale = await this.ctx.col.liveRooms
      .find({ status: 'live', lastHeartbeatAt: { $lt: cutoff } }, { projection: { _id: 1 } })
      .limit(500)
      .toArray();
    let ended = 0;
    for (const r of stale) if (await this.end(r._id, 'stale', null)) ended++;
    // Expire seat requests/invites past their TTL.
    await this.ctx.col.seatRequests.updateMany(
      { status: 'pending', expiresAt: { $lte: this.ctx.clock.now() } },
      { $set: { status: 'expired' } },
    );
    return ended;
  }
}
